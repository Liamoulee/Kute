use std::{
    ffi::c_void,
    mem::{self, transmute},
    ptr,
    sync::{
        self, LazyLock,
        atomic::{AtomicBool, AtomicPtr, AtomicUsize},
        mpsc::{Sender, channel},
    },
    thread,
};
use windows::Win32::{
    Foundation::*,
    Graphics::Dwm::*,
    System::{
        LibraryLoader::GetModuleHandleW,
        SystemServices::{MK_CONTROL, MK_LBUTTON},
        Threading::*,
    },
    UI::{
        Accessibility::*,
        Input::{KeyboardAndMouse::*, *},
        WindowsAndMessaging::*,
    },
};
use windows::core::*;

use crate::{debug_print, utils};

static SPACE_DOWN: INPUT = INPUT {
    r#type: INPUT_KEYBOARD,
    Anonymous: INPUT_0 {
        ki: KEYBDINPUT {
            wVk: VK_SPACE,
            wScan: 0,
            dwFlags: KEYBD_EVENT_FLAGS(0),
            time: 0,
            dwExtraInfo: 0,
        },
    },
};

static SPACE_UP: INPUT = INPUT {
    r#type: INPUT_KEYBOARD,
    Anonymous: INPUT_0 {
        ki: KEYBDINPUT {
            wVk: VK_SPACE,
            wScan: 0,
            dwFlags: KEYEVENTF_KEYUP,
            time: 0,
            dwExtraInfo: 0,
        },
    },
};

static SCROLL_SENDER: LazyLock<Sender<()>> = LazyLock::new(|| {
    let (tx, rx) = channel();
    thread::spawn(move || {
        debug_print!("input: rampboost input thread started id={}", unsafe { GetCurrentThreadId() });
        while rx.recv().is_ok() {
            unsafe {
                let down = SendInput(&[SPACE_DOWN], mem::size_of::<INPUT>() as i32);
                Sleep(5);
                let up = SendInput(&[SPACE_UP], mem::size_of::<INPUT>() as i32);
                if down != 1 || up != 1 {
                    debug_print!("input: rampboost SendInput incomplete down={down} up={up}");
                }
            }
        }
    });
    tx
});

static mut PREV_WNDPROC_1: WNDPROC = None;
static mut PREV_WNDPROC_2: WNDPROC = None;

// true while the game holds the pointer
static POINTER_LOCKED: AtomicBool = AtomicBool::new(false);
static F20_DOWN: AtomicBool = AtomicBool::new(false);
static RAMPBOOST: AtomicBool = AtomicBool::new(false);
static WINDOW_HANDLE: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
static RENDER_WIDGET: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
static HOOK_HANDLE: AtomicUsize = AtomicUsize::new(0);
static STARTED: AtomicBool = AtomicBool::new(false);

struct ChromeWindows {
    chrome_window: HWND,
    chrome_renderwidget: HWND,
}

impl ChromeWindows {
    fn get(parent: HWND) -> Self {
        let windows = ChromeWindows {
            chrome_window: utils::find_child_window_by_class(parent, "Chrome_WidgetWin_"),
            chrome_renderwidget: utils::find_child_window_by_class(parent, "Chrome_RenderWidgetHostHWND"),
        };
        debug_print!(
            "input: child windows parent={:?} chrome={:?} render_widget={:?}",
            parent,
            windows.chrome_window,
            windows.chrome_renderwidget,
        );
        windows
    }

    // chromium creates placeholder render widget windows first, the one showing the page covers the parent
    fn complete(&self, parent: HWND) -> bool {
        if self.chrome_window.0.is_null() || self.chrome_renderwidget.0.is_null() {
            return false;
        }
        unsafe {
            let mut parent_rect = RECT::default();
            let mut widget_rect = RECT::default();
            GetClientRect(parent, &mut parent_rect).ok();
            GetWindowRect(self.chrome_renderwidget, &mut widget_rect).ok();
            let parent_area = (parent_rect.right - parent_rect.left).max(1) as i64 * (parent_rect.bottom - parent_rect.top).max(1) as i64;
            let widget_area = (widget_rect.right - widget_rect.left).max(0) as i64 * (widget_rect.bottom - widget_rect.top).max(0) as i64;
            widget_area * 2 >= parent_area
        }
    }

    // each window on its own: every page load brings a new render widget while the outer window stays, and
    // returning once the outer one was ours left every widget after the first page load without its hook
    unsafe fn set_window_procs(&self) {
        unsafe {
            let original_proc_1 = GetWindowLongPtrW(self.chrome_window, GWLP_WNDPROC);
            if original_proc_1 != wnd_proc_1 as *const () as isize {
                debug_print!("input: original chrome wndproc={original_proc_1:#x}");
                PREV_WNDPROC_1 = transmute::<isize, Option<unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT>>(original_proc_1);
                let _previous = SetWindowLongPtrW(self.chrome_window, GWLP_WNDPROC, wnd_proc_1 as *const () as isize);
                debug_print!("input: installed chrome wndproc, previous={_previous:#x}");
            }

            let original_proc_2 = GetWindowLongPtrW(self.chrome_renderwidget, GWLP_WNDPROC);
            if original_proc_2 == wnd_proc_widget as *const () as isize || original_proc_2 == wnd_proc_widget_rampboost as *const () as isize {
                return;
            }
            debug_print!("input: original render widget wndproc={original_proc_2:#x}");
            PREV_WNDPROC_2 = transmute::<isize, Option<unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT>>(original_proc_2);
            RENDER_WIDGET.store(self.chrome_renderwidget.0, sync::atomic::Ordering::Relaxed);
            let _previous = SetWindowLongPtrW(self.chrome_renderwidget, GWLP_WNDPROC, widget_proc());
            debug_print!("input: installed render widget wndproc, previous={_previous:#x}");
        }
    }
}

pub fn set_pointer_locked(locked: bool) {
    POINTER_LOCKED.store(locked, sync::atomic::Ordering::Relaxed);
    debug_print!("input: pointer locked={locked}");
}

// the procedure the render widget gets, remembered so a widget hooked later (after a page load) gets the same
fn widget_proc() -> isize {
    if RAMPBOOST.load(sync::atomic::Ordering::Relaxed) {
        wnd_proc_widget_rampboost as *const () as isize
    } else {
        wnd_proc_widget as *const () as isize
    }
}

// switches the render widget between the plain and the ramp boost window procedure
pub fn set_rampboost(enabled: bool) {
    RAMPBOOST.store(enabled, sync::atomic::Ordering::Relaxed);
    let widget = HWND(RENDER_WIDGET.load(sync::atomic::Ordering::Relaxed));
    if widget.0.is_null() {
        return;
    }
    unsafe {
        SetWindowLongPtrW(widget, GWLP_WNDPROC, widget_proc());
    }
    debug_print!("input: rampboost={enabled}");
}

// the browser's child windows may appear a little after on_after_created, so keep looking
pub fn attach(parent: HWND) {
    WINDOW_HANDLE.store(parent.0, sync::atomic::Ordering::Relaxed);

    thread::spawn(move || {
        let parent = HWND(WINDOW_HANDLE.load(sync::atomic::Ordering::Relaxed));
        for _ in 0..600 {
            let chrome_windows = ChromeWindows::get(parent);
            if chrome_windows.complete(parent) {
                unsafe { chrome_windows.set_window_procs() };
                break;
            }
            unsafe { Sleep(50) };
        }
    });

    if STARTED.swap(true, sync::atomic::Ordering::SeqCst) {
        return;
    }

    // re-hook if the main window gets recreated (see the subwindow WM_COPYDATA path) or
    // chromium replaced the render widget window, which it does on every page load (a new lobby). every
    // second, because until then the new page runs without the wheel handling. a tick is one IsWindow call
    thread::spawn(move || {
        loop {
            unsafe {
                Sleep(1000);
                let mut current_parent = HWND(WINDOW_HANDLE.load(sync::atomic::Ordering::Relaxed));
                if !IsWindow(Some(current_parent)).as_bool() {
                    let Ok(new_parent) = FindWindowW(w!("kute_webview"), PCWSTR::null()) else {
                        continue;
                    };
                    WINDOW_HANDLE.store(new_parent.0, sync::atomic::Ordering::Relaxed);
                    debug_print!("input: main window recreated={new_parent:?}");
                    current_parent = new_parent;
                }
                let widget = HWND(RENDER_WIDGET.load(sync::atomic::Ordering::Relaxed));
                if IsWindow(Some(widget)).as_bool() {
                    continue;
                }
                let new_chrome_windows = ChromeWindows::get(current_parent);
                if new_chrome_windows.complete(current_parent) {
                    new_chrome_windows.set_window_procs();
                }
            }
        }
    });

    thread::spawn(move || {
        unsafe {
            debug_print!("input: WinEvent message thread started id={}", GetCurrentThreadId());
            // whenever a window gets created check if it has the Chrome.WindowTranslucent attribute
            // (the one that warns about pointer lock) and if it does, destroy it
            let hook = SetWinEventHook(
                EVENT_OBJECT_CREATE,
                EVENT_OBJECT_CREATE,
                None,
                Some(window_event_proc),
                GetCurrentProcessId(),
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            HOOK_HANDLE.store(hook.0 as usize, sync::atomic::Ordering::Relaxed);
            debug_print!("input: SetWinEventHook handle={:?}", hook);

            let mut msg: MSG = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).into() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    });
}

unsafe extern "system" fn dummy_wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

// OBS "Application Audio Capture" needs a window owned by the process that plays the audio, which is the audio
// service utility process (main.rs). This used to run here as well, from the days this file was a DLL loaded into
// several processes, and the browser process it now lives in plays no audio: that window was a silent duplicate
pub fn spawn_audio_window_thread() {
    thread::spawn(|| {
        let hinstance = unsafe { GetModuleHandleW(None).unwrap().into() };

        let class_name = w!("Audio_Target_Class");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(dummy_wnd_proc),
            hInstance: hinstance,
            lpszClassName: class_name,
            ..Default::default()
        };
        unsafe { RegisterClassW(&wc) };

        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE,
                class_name,
                w!("Kute audio window"),
                WS_POPUP | WS_VISIBLE,
                -32000,
                -32000,
                1,
                1,
                None,
                None,
                Some(hinstance),
                None,
            )
            .unwrap()
        };

        unsafe {
            // makes window transparent
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_ALPHA);

            // set an invisible owner window
            // drops it from the taskbar
            let desktop_hwnd = GetDesktopWindow();
            SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, desktop_hwnd.0 as isize);

            const DWMWA_CLOAK: u32 = 13;
            let cloak_value: i32 = 1;
            _ = DwmSetWindowAttribute(
                hwnd,
                DWMWINDOWATTRIBUTE(DWMWA_CLOAK.try_into().unwrap()),
                &cloak_value as *const i32 as *const _,
                std::mem::size_of::<i32>() as u32,
            );

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, Some(hwnd), 0, 0).into() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    });
}

#[unsafe(no_mangle)]
unsafe extern "system" fn wnd_proc_1(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match message {
            WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => {
                if POINTER_LOCKED.load(sync::atomic::Ordering::Relaxed) {
                    F20_DOWN.store(true, sync::atomic::Ordering::Relaxed);
                    return CallWindowProcW(PREV_WNDPROC_1, window, WM_KEYDOWN, WPARAM(VK_F20.0 as usize), lparam);
                }
                CallWindowProcW(PREV_WNDPROC_1, window, message, wparam, lparam)
            }
            WM_LBUTTONUP => {
                if F20_DOWN.swap(false, sync::atomic::Ordering::Relaxed) {
                    CallWindowProcW(PREV_WNDPROC_1, window, WM_KEYUP, WPARAM(VK_F20.0 as usize), lparam);
                }
                CallWindowProcW(PREV_WNDPROC_1, window, message, wparam, lparam)
            }
            WM_RBUTTONDOWN | WM_RBUTTONDBLCLK | WM_XBUTTONDOWN | WM_NCXBUTTONDBLCLK | WM_MBUTTONDOWN | WM_MBUTTONDBLCLK => {
                CallWindowProcW(PREV_WNDPROC_1, window, message, WPARAM(wparam.0 & !MK_LBUTTON.0 as usize), lparam)
            }
            WM_CHAR => LRESULT(1),
            // when you press esc chromium puts a few seconds of delay before the pointer can get locked again as a security measure
            WM_KEYDOWN | WM_KEYUP => {
                if wparam.0 == VK_ESCAPE.0 as usize && POINTER_LOCKED.load(sync::atomic::Ordering::Relaxed) {
                    // the kute window, not the browser widget
                    let kute = WINDOW_HANDLE.load(sync::atomic::Ordering::Relaxed);
                    let _result = SetFocus(Some(HWND(kute)));
                    debug_print!("input: redirected Escape focus to client result={_result:?}");
                }
                CallWindowProcW(PREV_WNDPROC_1, window, message, wparam, lparam)
            }
            WM_MOUSEMOVE => {
                if POINTER_LOCKED.load(sync::atomic::Ordering::Relaxed) {
                    return CallWindowProcW(PREV_WNDPROC_1, window, message, WPARAM(wparam.0 & !MK_LBUTTON.0 as usize), lparam);
                }
                CallWindowProcW(PREV_WNDPROC_1, window, message, wparam, lparam)
            }
            WM_INPUT => {
                let mut buffer = std::mem::MaybeUninit::<RAWINPUT>::uninit();
                let mut size = std::mem::size_of::<RAWINPUT>() as u32;
                // with our libcef chromium itself keeps the movement and ignores the button in these packets (app.rs,
                // KuteRawInputMovementOnly), and dropping them here would throw the movement away again
                static CHROMIUM_FILTERS: LazyLock<bool> = LazyLock::new(|| crate::app::feature_enabled("KuteRawInputMovementOnly"));
                if *CHROMIUM_FILTERS {
                    return CallWindowProcW(PREV_WNDPROC_1, window, message, wparam, lparam);
                }
                // we only deny raw input events carrying a mouse button press, the movement itself is handled by chromium
                if GetRawInputData(
                    HRAWINPUT(lparam.0 as _),
                    RID_INPUT,
                    Some(buffer.as_mut_ptr() as _),
                    &mut size,
                    mem::size_of::<RAWINPUTHEADER>() as u32,
                ) != u32::MAX
                {
                    let raw = buffer.assume_init_ref();

                    // the union only holds mouse data in a mouse packet
                    if raw.header.dwType == RIM_TYPEMOUSE.0 && raw.data.mouse.Anonymous.Anonymous.usButtonFlags != 0 {
                        return LRESULT(1);
                    };
                }
                CallWindowProcW(PREV_WNDPROC_1, window, message, wparam, lparam)
            }
            _ => CallWindowProcW(PREV_WNDPROC_1, window, message, wparam, lparam),
        }
    }
}

// mirrors SetIsZoomControlEnabled(false)
fn is_zoom_wheel(wparam: WPARAM) -> bool {
    (wparam.0 & MK_CONTROL.0 as usize) != 0
}

#[unsafe(no_mangle)]
unsafe extern "system" fn wnd_proc_widget(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match message {
            WM_MOUSEWHEEL | WM_MOUSEHWHEEL | WM_POINTERWHEEL | WM_POINTERHWHEEL => {
                if is_zoom_wheel(wparam) {
                    return LRESULT(0);
                }
                if POINTER_LOCKED.load(sync::atomic::Ordering::Relaxed) {
                    let kute = WINDOW_HANDLE.load(sync::atomic::Ordering::Relaxed);
                    // send the message to the kute window, from where it gets sent as a js event
                    // best fix i could find for the fps dropping when scrolling whilst still keeping scroll behaviour intact
                    PostMessageW(Some(HWND(kute)), message, wparam, lparam).ok();
                    return LRESULT(1);
                }
                CallWindowProcW(PREV_WNDPROC_2, window, message, wparam, lparam)
            }
            _ => CallWindowProcW(PREV_WNDPROC_2, window, message, wparam, lparam),
        }
    }
}

#[unsafe(no_mangle)]
unsafe extern "system" fn wnd_proc_widget_rampboost(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match message {
            WM_MOUSEWHEEL | WM_MOUSEHWHEEL | WM_POINTERWHEEL | WM_POINTERHWHEEL => {
                if is_zoom_wheel(wparam) {
                    return LRESULT(0);
                }
                if POINTER_LOCKED.load(sync::atomic::Ordering::Relaxed) {
                    SCROLL_SENDER.send(()).ok();
                    return LRESULT(1);
                }
                CallWindowProcW(PREV_WNDPROC_2, window, message, wparam, lparam)
            }
            _ => CallWindowProcW(PREV_WNDPROC_2, window, message, wparam, lparam),
        }
    }
}

unsafe extern "system" fn window_event_proc(_hook: HWINEVENTHOOK, _event: u32, hwnd: HWND, _id_object: i32, _id_child: i32, _thread: u32, _time: u32) {
    unsafe {
        let prop = GetPropW(hwnd, w!("Chrome.WindowTranslucent"));
        if !prop.is_invalid() {
            debug_print!("input: destroying translucent Chrome window={hwnd:?}");
            PostMessageW(Some(hwnd), WM_DESTROY, WPARAM(0), LPARAM(0)).ok();
        }
    }
}
