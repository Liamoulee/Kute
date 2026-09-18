use crate::{app, bridge, debug_print, handlers, modules, utils, utils::config};
use cef::*;
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::c_void,
    slice,
    sync::atomic::{AtomicUsize, Ordering},
};
use windows::{
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::{DataExchange::COPYDATASTRUCT, LibraryLoader::GetModuleHandleW},
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
    core::*,
};

static WINDOW_COUNT: AtomicUsize = AtomicUsize::new(0);
static BROWSER_COUNT: AtomicUsize = AtomicUsize::new(0);
const RENDER_STATS_TIMER: usize = 1;

// CEF objects are UI thread only, the same thread that owns every window
thread_local! {
    static BROWSERS: RefCell<HashMap<i32, Browser>> = RefCell::new(HashMap::new());
    // browser id -> the kute window hosting it, valid even once CEF tore its own windows down
    static BROWSER_WINDOWS: RefCell<HashMap<i32, HWND>> = RefCell::new(HashMap::new());
    static MAIN_BROWSER: RefCell<Option<Browser>> = const { RefCell::new(None) };
}

#[derive(Copy, Clone, serde::Serialize, serde::Deserialize, Default, Debug)]
pub struct Position {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl From<RECT> for Position {
    fn from(rect: RECT) -> Self {
        Position {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }
}

#[derive(Copy, Clone, serde::Serialize, serde::Deserialize, Default, Debug)]
pub struct WindowState {
    pub fullscreen: bool,
    pub position: Position,
}

pub struct Window {
    pub hwnd: HWND,
    pub browser: Option<Browser>,
    pub state: WindowState,
    pub is_subwindow: bool,
    // set once CEF acknowledged the close, the next WM_CLOSE then destroys the window
    pub closing: bool,
}

impl Window {
    pub fn toggle_fullscreen(&mut self) {
        unsafe {
            if self.state.fullscreen {
                SetWindowLongPtrW(self.hwnd, GWL_STYLE, (WS_VISIBLE.0 | WS_OVERLAPPEDWINDOW.0) as _);

                SetWindowPos(
                    self.hwnd,
                    Some(HWND_TOP),
                    self.state.position.left,
                    self.state.position.top,
                    self.state.position.right - self.state.position.left,
                    self.state.position.bottom - self.state.position.top,
                    SWP_NOZORDER | SWP_FRAMECHANGED,
                )
                .ok();
            } else {
                let mut rect = RECT::default();
                GetWindowRect(self.hwnd, &mut rect).ok();
                self.state.position = Position::from(rect);

                let h_monitor = MonitorFromWindow(self.hwnd, MONITOR_DEFAULTTONEAREST);

                let mut monitor_info = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };

                let _ = GetMonitorInfoW(h_monitor, &mut monitor_info);

                SetWindowLongPtrW(self.hwnd, GWL_STYLE, (WS_VISIBLE.0) as _);

                SetWindowPos(
                    self.hwnd,
                    Some(HWND_TOP),
                    monitor_info.rcMonitor.left,
                    monitor_info.rcMonitor.top,
                    monitor_info.rcMonitor.right - monitor_info.rcMonitor.left,
                    monitor_info.rcMonitor.bottom - monitor_info.rcMonitor.top,
                    SWP_NOZORDER | SWP_FRAMECHANGED,
                )
                .ok();
            }
            self.state.fullscreen = !self.state.fullscreen;
        }
    }

    fn browser_hwnd(&self) -> Option<HWND> {
        let host = self.browser.as_ref()?.host()?;
        let handle = host.window_handle().0;
        if handle.is_null() { None } else { Some(HWND(handle.cast())) }
    }

    fn resize_browser(&self, width: i32, height: i32) {
        if let Some(browser_hwnd) = self.browser_hwnd() {
            unsafe {
                SetWindowPos(browser_hwnd, None, 0, 0, width, height, SWP_NOZORDER | SWP_NOACTIVATE).ok();
            }
        }
    }
}

pub fn window_from_hwnd(hwnd: HWND) -> Option<&'static mut Window> {
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return None;
        }
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Window;
        if ptr.is_null() { None } else { Some(&mut *ptr) }
    }
}

// our top-level window that hosts the browser
pub fn root_hwnd(browser: &Browser) -> Option<HWND> {
    let host = browser.host()?;
    let handle = host.window_handle().0;
    if handle.is_null() {
        return None;
    }
    let root = unsafe { GetAncestor(HWND(handle.cast()), GA_ROOT) };
    if root.0.is_null() { None } else { Some(root) }
}

pub fn window_from_browser(browser: &Browser) -> Option<&'static mut Window> {
    let hwnd = BROWSER_WINDOWS
        .with_borrow(|m| m.get(&browser.identifier()).copied())
        .or_else(|| root_hwnd(browser))?;
    window_from_hwnd(hwnd)
}

// hides or shows the browser's own child window. a hidden page stops rendering
pub fn set_browser_visible(browser: &Browser, visible: bool) {
    let Some(host) = browser.host() else { return };
    let handle = host.window_handle().0;
    if handle.is_null() {
        return;
    }
    unsafe {
        let _ = ShowWindow(HWND(handle.cast()), if visible { SW_SHOW } else { SW_HIDE });
    }
    if visible {
        host.set_focus(1);
    }
}

// left, top, right, bottom of the window's client area in screen pixels
pub fn client_rect_on_screen(browser: &Browser) -> Option<[i32; 4]> {
    let hwnd = root_hwnd(browser)?;
    unsafe {
        let mut rect = RECT::default();
        GetClientRect(hwnd, &mut rect).ok()?;
        let mut origin = POINT::default();
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return None;
        }
        Some([origin.x, origin.y, origin.x + rect.right, origin.y + rect.bottom])
    }
}

pub fn browser_by_id(id: i32) -> Option<Browser> {
    BROWSERS.with_borrow(|b| b.get(&id).cloned())
}

// on_after_created: link the browser to the window it was created in
pub fn attach_browser(browser: &Browser) {
    BROWSER_COUNT.fetch_add(1, Ordering::SeqCst);
    BROWSERS.with_borrow_mut(|b| b.insert(browser.identifier(), browser.clone()));

    // a browser outside our windows is chromium acting on its own (session restore and the like), drop it
    let Some((hwnd, window)) = root_hwnd(browser).and_then(|hwnd| window_from_hwnd(hwnd).map(|w| (hwnd, w))) else {
        debug_print!("window: browser {} has no kute window, closing it", browser.identifier());
        if let Some(host) = browser.host() {
            host.close_browser(1);
        }
        return;
    };
    BROWSER_WINDOWS.with_borrow_mut(|m| m.insert(browser.identifier(), hwnd));
    window.browser = Some(browser.clone());
    unsafe {
        let mut rect = RECT::default();
        GetClientRect(hwnd, &mut rect).ok();
        window.resize_browser(rect.right - rect.left, rect.bottom - rect.top);
    }

    if browser.is_popup() == 0 {
        MAIN_BROWSER.set(Some(browser.clone()));
        if let Some(bench) = modules::bench::config() {
            modules::devtools::set_cpu_throttling(browser, bench.throttle);
            return;
        }
        modules::input::attach(hwnd);
        modules::priority::set(config("webviewPriority", "Normal".to_string()));
        if config("realPing", false) {
            modules::ping::load(browser);
        }
        if config("renderStats", false) {
            unsafe {
                SetTimer(Some(hwnd), RENDER_STATS_TIMER, 100, None);
            }
        }
    }
}

// do_close: CEF accepted the close, the next WM_CLOSE destroys the window
pub fn mark_closing(browser: &Browser) {
    debug_print!("window: browser {} closing", browser.identifier());
    if let Some(window) = window_from_browser(browser) {
        window.closing = true;
    }
}

// on_before_close: the browser object is gone, so the window that hosted it goes too
pub fn detach_browser(browser: &Browser) {
    let id = browser.identifier();
    debug_print!("window: browser {id} closed");
    BROWSERS.with_borrow_mut(|b| b.remove(&id));
    if MAIN_BROWSER.with_borrow(|b| b.as_ref().is_some_and(|m| m.identifier() == id)) {
        MAIN_BROWSER.set(None);
    }
    if let Some(window) = window_from_browser(browser) {
        window.browser = None;
        window.closing = true;
        unsafe {
            PostMessageW(Some(window.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).ok();
        }
    }
    BROWSER_WINDOWS.with_borrow_mut(|m| m.remove(&id));
    if BROWSER_COUNT.fetch_sub(1, Ordering::SeqCst) == 1 && WINDOW_COUNT.load(Ordering::SeqCst) == 0 {
        debug_print!("window: last browser closed, quitting");
        quit_message_loop();
    }
}

// "close" from the page: shut every window down the regular way. only this process's windows,
// a bench run and the client can be open at the same time
pub fn close_all() {
    let windows: Vec<HWND> = BROWSER_WINDOWS.with_borrow(|m| m.values().copied().collect());
    for hwnd in windows {
        unsafe {
            PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).ok();
        }
    }
}

pub fn handle_accelerator_key(browser: &Browser, key: u16) {
    match VIRTUAL_KEY(key) {
        VK_F4 | VK_F6 => {
            modules::devtools::set_cpu_throttling(browser, 1.0);
            if let Some(frame) = browser.main_frame() {
                let current_url = utils::cef_to_string(&frame.url());
                let target_url = current_url
                    .split_once("game=")
                    .map(|(_before, after)| after.trim())
                    .filter(|id| !id.is_empty())
                    .map(|id| format!("https://krunker.io/?exclude={}", id))
                    .unwrap_or_else(|| "https://krunker.io/".to_string());
                frame.load_url(Some(&CefString::from(target_url.as_str())));
            }
            modules::input::set_pointer_locked(false);
        }
        VK_F5 => {
            modules::devtools::set_cpu_throttling(browser, 1.0);
            browser.reload();
            modules::input::set_pointer_locked(false);
        }
        VK_F11 => {
            if let Some(window) = window_from_browser(browser) {
                window.toggle_fullscreen();
            }
        }
        VK_F12 => {
            if let Some(host) = browser.host() {
                host.show_dev_tools(None, None, None, None);
            }
        }
        _ => {}
    }
}

pub fn create_main_window() {
    let start_mode = config("startMode", "Remember Previous".to_string());
    let state = if start_mode == "Remember Previous" {
        config("lastPosition", None::<WindowState>)
    } else {
        None
    };

    if let Some([left, top, right, bottom]) = modules::bench::config().and_then(|bench| bench.rect) {
        let locked = modules::bench::config().is_some_and(|bench| bench.locked);
        let state = WindowState {
            // borderless, so the rect is the client area
            fullscreen: locked,
            position: Position { left, top, right, bottom },
        };
        let hwnd = create_window("Remember Previous", false, Some(state));
        if locked {
            // in front of the client without taking its focus, no taskbar entry, and deaf to mouse and keyboard
            unsafe {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE).0 as _);
                SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    left,
                    top,
                    right - left,
                    bottom - top,
                    SWP_NOACTIVATE | SWP_FRAMECHANGED,
                )
                .ok();
                SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE).ok();
                let _ = EnableWindow(hwnd, false);
            }
        }
        create_browser(hwnd, &modules::bench::url());
        return;
    }

    let hwnd = create_window(&start_mode, false, state);
    if modules::bench::active() {
        create_browser(hwnd, &modules::bench::url());
    } else {
        create_browser(hwnd, crate::constants::KRUNKER_URL);
    }
}

fn create_browser(hwnd: HWND, url: &str) {
    let mut rect = RECT::default();
    unsafe {
        GetClientRect(hwnd, &mut rect).ok();
    }
    let bounds = Rect {
        x: 0,
        y: 0,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    };
    let window_info = WindowInfo::default().set_as_child(sys::HWND(hwnd.0.cast()), &bounds);
    let mut client = handlers::KuteClient::new();
    let url = CefString::from(url);
    let mut request_context = app::request_context();
    if browser_host_create_browser(
        Some(&window_info),
        Some(&mut client),
        Some(&url),
        Some(&app::browser_settings()),
        None,
        request_context.as_mut(),
    ) == 0
    {
        eprintln!("browser_host_create_browser failed");
    }
}

// popup (window.open) requested by the page, mirrors the NewWindowRequested handler
pub fn create_popup_window(
    features: Option<&PopupFeatures>,
    window_info: Option<&mut WindowInfo>,
    client: Option<&mut Option<Client>>,
    settings: Option<&mut BrowserSettings>,
) {
    let mut window_state = None;
    if let Some(features) = features
        && features.x_set != 0
        && features.y_set != 0
        && features.width_set != 0
        && features.height_set != 0
    {
        window_state = Some(WindowState {
            fullscreen: false,
            position: Position {
                left: features.x,
                top: features.y,
                right: features.x + features.width,
                bottom: features.y + features.height,
            },
        });
    }

    let hwnd = create_window("Custom", true, window_state);
    let mut rect = RECT::default();
    unsafe {
        GetClientRect(hwnd, &mut rect).ok();
    }
    let bounds = Rect {
        x: 0,
        y: 0,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    };
    if let Some(window_info) = window_info {
        *window_info = window_info.clone().set_as_child(sys::HWND(hwnd.0.cast()), &bounds);
    }
    if let Some(client) = client {
        *client = Some(handlers::KuteClient::new());
    }
    if let Some(settings) = settings {
        *settings = app::browser_settings();
    }
}

// kute.ico carries simplified art for 16 to 32 px and the detailed logo above that (resources/make-ico.py).
// the class icon is one handle at the 32 px class, so the title bar icon would be whatever windows derives from
// it. asking for the exact sizes the system uses (they grow with the display scale) gets the entry made for them
unsafe fn set_window_icons(hwnd: HWND, hinstance: HINSTANCE) {
    unsafe {
        for (kind, width, height) in [(ICON_SMALL, SM_CXSMICON, SM_CYSMICON), (ICON_BIG, SM_CXICON, SM_CYICON)] {
            let (width, height) = (GetSystemMetrics(width), GetSystemMetrics(height));
            if let Ok(icon) = LoadImageW(Some(hinstance), w!("icon"), IMAGE_ICON, width, height, LR_SHARED) {
                SendMessageW(hwnd, WM_SETICON, Some(WPARAM(kind as usize)), Some(LPARAM(icon.0 as isize)));
            }
        }
    }
}

pub fn create_window(start_mode: &str, is_subwindow: bool, init_state: Option<WindowState>) -> HWND {
    unsafe {
        let hinstance: HINSTANCE = GetModuleHandleW(None).unwrap().into();
        let icon = match LoadIconW(Some(hinstance), w!("icon")) {
            Ok(icon) => icon,
            Err(_) => LoadIconW(None, IDI_APPLICATION).unwrap(),
        };
        // input.rs and the single instance check find the client by these names, a bench window must not match
        let class_name = if modules::bench::active() {
            w!("kute_bench")
        } else if is_subwindow {
            w!("kute_webview_subwindow")
        } else {
            w!("kute_webview")
        };
        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc_setup),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: icon,
            hCursor: Default::default(),
            hbrBackground: CreateSolidBrush(COLORREF(0x00000000)),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: class_name,
        };

        RegisterClassW(&wc);

        let screen_width = GetSystemMetrics(SM_CXSCREEN);
        let screen_height = GetSystemMetrics(SM_CYSCREEN);

        fn windowed_size(state: &mut WindowState) {
            let screen_width = unsafe { GetSystemMetrics(SM_CXSCREEN) };
            let screen_height = unsafe { GetSystemMetrics(SM_CYSCREEN) };
            let window_width = (screen_width as f32 * 0.8) as i32;
            let window_height = (screen_height as f32 * 0.8) as i32;
            let left = (screen_width - window_width) / 2;
            let top = (screen_height - window_height) / 2;
            state.fullscreen = false;
            state.position = Position {
                left,
                top,
                right: left + window_width,
                bottom: top + window_height,
            };
        }

        let mut state: WindowState = {
            //fallback
            let mut creation_state = WindowState {
                fullscreen: true,
                position: Position {
                    left: 0,
                    top: 0,
                    right: screen_width,
                    bottom: screen_height,
                },
            };
            match start_mode {
                "Borderless Fullscreen" => {}
                "Maximized" => {
                    creation_state.fullscreen = false;
                }
                "Remember Previous" => {
                    if let Some(init_state) = init_state {
                        creation_state = init_state;
                    }
                }
                "Custom" => {
                    if let Some(init_state) = init_state {
                        creation_state = init_state;
                    } else {
                        windowed_size(&mut creation_state);
                    }
                }
                _ => {
                    windowed_size(&mut creation_state);
                }
            }
            creation_state
        };

        let rect = RECT {
            left: state.position.left,
            top: state.position.top,
            right: state.position.right,
            bottom: state.position.bottom,
        };

        // check if its on another monitor or off-screen
        let h_monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONULL);
        let (x, y, width, height) = if h_monitor.is_invalid() {
            state.fullscreen = false;
            (CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT)
        } else {
            let mut monitor = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            let _ = GetMonitorInfoW(h_monitor, &mut monitor);

            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;

            let clamped_x = rect.left.clamp(monitor.rcWork.left, monitor.rcWork.left.max(monitor.rcWork.right - w));

            let clamped_y = rect.top.clamp(monitor.rcWork.top, monitor.rcWork.top.max(monitor.rcWork.bottom - h));

            (clamped_x, clamped_y, w, h)
        };

        let hwnd: HWND = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            w!("Kute"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            x,
            y,
            width,
            height,
            None,
            None,
            Some(hinstance),
            Some((is_subwindow as isize) as *mut c_void),
        )
        .unwrap();
        set_window_icons(hwnd, hinstance);

        if state.fullscreen {
            SetWindowLongPtrW(hwnd, GWL_STYLE, (WS_VISIBLE.0) as _);
        }

        let window = Box::new(Window {
            hwnd,
            browser: None,
            state,
            is_subwindow,
            closing: false,
        });
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(window) as isize);

        hwnd
    }
}

unsafe extern "system" fn wnd_proc_setup(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        if msg == WM_NCCREATE {
            let create_struct = lparam.0 as *const CREATESTRUCTW;
            let is_subwindow = (*create_struct).lpCreateParams as isize;
            WINDOW_COUNT.fetch_add(1, Ordering::SeqCst);
            let wnd_proc = if is_subwindow == 0 {
                wnd_proc_main as *const () as isize
            } else {
                wnd_proc_subwindow as *const () as isize
            };

            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, wnd_proc);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

// messages both window kinds handle the same way, Some(result) when handled
unsafe fn wnd_proc_common(window: &mut Window, hwnd: HWND, msg: u32, _wparam: WPARAM, lparam: LPARAM) -> Option<LRESULT> {
    unsafe {
        match msg {
            WM_SETFOCUS => {
                if let Some(host) = window.browser.as_ref().and_then(|b| b.host()) {
                    host.set_focus(1);
                }
            }
            WM_SIZE => {
                window.resize_browser(utils::LOWORD(lparam.0 as usize) as i32, utils::HIWORD(lparam.0 as usize) as i32);
            }
            WM_MOVE | WM_MOVING => {
                if let Some(host) = window.browser.as_ref().and_then(|b| b.host()) {
                    host.notify_move_or_resize_started();
                }
            }
            WM_ERASEBKGND => {
                if window.browser.is_some() {
                    return Some(LRESULT(1));
                }
            }
            WM_CLOSE => {
                // ask CEF first, it sends WM_CLOSE again once the browser agreed (see do_close)
                if !window.closing
                    && let Some(host) = window.browser.as_ref().and_then(|b| b.host())
                {
                    window.closing = true;
                    host.close_browser(0);
                    return Some(LRESULT(0));
                }
            }
            WM_DESTROY => {
                if !window.is_subwindow {
                    let mut rect = RECT::default();
                    GetWindowRect(hwnd, &mut rect).ok();
                    window.state.position = Position::from(rect);
                    let styles = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
                    window.state.fullscreen = (styles & WS_OVERLAPPEDWINDOW.0) == 0;
                    crate::CONFIG.lock().unwrap().set("lastPosition", window.state);
                }

                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                drop(Box::from_raw(window as *mut Window));
                let count = WINDOW_COUNT.fetch_sub(1, Ordering::SeqCst);
                debug_print!("window: {hwnd:?} destroyed, {} left", count - 1);
                if count == 1 && BROWSER_COUNT.load(Ordering::SeqCst) == 0 {
                    debug_print!("window: last window destroyed, quitting");
                    quit_message_loop();
                }
                return Some(LRESULT(0));
            }
            _ => {}
        }
        None
    }
}

unsafe extern "system" fn wnd_proc_main(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        let window_data_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Window;
        if window_data_ptr.is_null() {
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        let window = &mut *window_data_ptr;

        match msg {
            WM_MOUSEWHEEL => {
                // forwarded by the input hooks while the game holds the pointer
                let delta = (utils::HIWORD(wparam.0) as i16) as i32;
                let scroll_amount = delta as f32 / WHEEL_DELTA as f32;
                if let Some(browser) = window.browser.as_ref() {
                    bridge::post_json(browser, &format!("{{\"wheel\":{}}}", scroll_amount));
                }
            }
            WM_TIMER if wparam.0 == RENDER_STATS_TIMER => {
                thread_local! {
                    static LAST_RENDER_STATS: std::cell::Cell<Option<(u64, u64)>> = const { std::cell::Cell::new(None) };
                }
                if let Some(current) = app::render_stats()
                    && current.0 > 0
                    && LAST_RENDER_STATS.get() != Some(current)
                {
                    LAST_RENDER_STATS.set(Some(current));
                    if let Some(browser) = window.browser.as_ref() {
                        bridge::post_json(browser, &format!("{{\"fpsInfo\":{}}}", current.0));
                    }
                }
            }
            WM_COPYDATA => {
                let cds_ptr = lparam.0 as *mut COPYDATASTRUCT;
                let cds = &*cds_ptr;
                let data: &[u8] = slice::from_raw_parts(cds.lpData as *const u8, cds.cbData as usize);
                if let Ok(mut string) = String::from_utf8(data.to_vec()) {
                    debug_print!("window: args from another instance: {string}");
                    string = serde_json::to_string(&string).unwrap_or_else(|_| String::new());
                    if let Some(browser) = window.browser.as_ref() {
                        bridge::post_json(browser, &format!("{{\"args\":{}}}", string));
                    }
                }
            }
            _ => {
                if let Some(result) = wnd_proc_common(window, hwnd, msg, wparam, lparam) {
                    return result;
                }
            }
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

unsafe extern "system" fn wnd_proc_subwindow(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        let window_data_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Window;
        if window_data_ptr.is_null() {
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        let window = &mut *window_data_ptr;

        match msg {
            WM_COPYDATA => {
                // only the social window is left, bring the game back and hand it the args
                if WINDOW_COUNT.load(Ordering::SeqCst) != 1 {
                    return DefWindowProcW(hwnd, msg, wparam, lparam);
                }
                let cds_ptr = lparam.0 as *mut COPYDATASTRUCT;
                let cds = &*cds_ptr;
                let data = slice::from_raw_parts(cds.lpData as *const u8, cds.cbData as usize);
                if let Ok(string) = String::from_utf8(data.to_vec()) {
                    handlers::set_pending_args(string);
                }
                create_main_window();
            }
            _ => {
                if let Some(result) = wnd_proc_common(window, hwnd, msg, wparam, lparam) {
                    return result;
                }
            }
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}
