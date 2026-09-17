#![allow(non_snake_case)]
use crate::CONFIG;
use std::{
    convert, env, fs, io,
    path::{self, *},
};
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM},
        UI::WindowsAndMessaging::*,
    },
    core::*,
};

pub fn create_utf_string(string: impl AsRef<str>) -> Vec<u16> {
    let s = string.as_ref();
    let mut v = Vec::with_capacity(s.len() + 1);
    v.extend(s.encode_utf16());
    v.push(0);
    v
}

pub fn LOWORD(l: usize) -> usize {
    l & 0xffff
}

pub fn HIWORD(l: usize) -> usize {
    (l >> 16) & 0xffff
}

pub fn settings_dir() -> path::PathBuf {
    path::PathBuf::from(env::var("USERPROFILE").unwrap()).join("Documents").join("kute")
}

pub fn exe_dir() -> path::PathBuf {
    env::current_exe().unwrap().parent().unwrap().to_path_buf()
}

pub fn config<T: serde::de::DeserializeOwned>(setting: &str, default: T) -> T {
    CONFIG.lock().unwrap().get(setting).unwrap_or(default)
}

// the value of --type=<kind>, None for the browser process
pub fn process_type() -> Option<String> {
    env::args().find_map(|arg| arg.strip_prefix("--type=").map(str::to_string))
}

pub fn has_arg(wanted: &str) -> bool {
    env::args().any(|arg| arg == wanted)
}

// cef string helpers, CefStringUserfree has no Display
pub fn cef_to_string(value: &cef::CefStringUserfree) -> String {
    cef::CefStringUtf16::from(value).to_string()
}

pub fn cef_str(value: Option<&cef::CefString>) -> String {
    value.map(|v| v.to_string()).unwrap_or_default()
}

// substring match on the class name, "Chrome_WidgetWin_" finds both _0 and _1.
// chromium keeps spare render widget windows around, so the largest match wins
pub fn find_child_window_by_class(parent: HWND, class_name: &str) -> HWND {
    let mut data = (HWND::default(), class_name, 0i64);

    extern "system" fn enum_child_proc(handle: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let data = lparam.0 as *mut (HWND, &str, i64);
            let target_class = (*data).1;
            let mut class_name: [u16; 256] = [0; 256];

            GetClassNameW(handle, &mut class_name);
            let len = class_name.iter().position(|&c| c == 0).unwrap_or(256);
            let class_slice = &class_name[..len];
            let mut target_wide = [0u16; 64];
            let mut target_len = 0;
            for c in target_class.encode_utf16() {
                target_wide[target_len] = c;
                target_len += 1;
            }
            let target_slice = &target_wide[..target_len];
            if class_slice.windows(target_len).any(|w| w == target_slice) {
                let mut rect = windows::Win32::Foundation::RECT::default();
                GetWindowRect(handle, &mut rect).ok();
                let area = (rect.right - rect.left).max(0) as i64 * (rect.bottom - rect.top).max(0) as i64;
                if (*data).0.0.is_null() || area > (*data).2 {
                    (*data).0 = handle;
                    (*data).2 = area;
                }
            }

            BOOL(1)
        }
    }
    unsafe {
        let _ = EnumChildWindows(Some(parent), Some(enum_child_proc), LPARAM(&mut data as *mut (HWND, &str, i64) as _));
        if data.0.0.is_null() {
            crate::debug_print!("utils: no child window with class {class_name} under {parent:?}");
        }

        data.0
    }
}

pub fn atomic_write(path: &impl AsRef<Path>, data: &impl convert::AsRef<[u8]>) -> io::Result<()> {
    let path = path.as_ref();
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, data)?;

    fs::rename(tmp_path, path)?;
    Ok(())
}

#[macro_export]
macro_rules! debug_print {
    ($($arg:tt)*) => {
        if cfg!(feature = "verbose-logs") {
            let msg = format!($($arg)*);
            // dev builds keep a console, so the same line also goes to stderr
            eprintln!("{msg}");
            let wide: Vec<u16> = msg.encode_utf16().chain(Some(0)).collect();
            #[allow(unused_unsafe)]
            unsafe {
                ::windows::Win32::System::Diagnostics::Debug::OutputDebugStringW(
                    ::windows::core::PCWSTR(wide.as_ptr()),
                );
            }
        }
    };
}
