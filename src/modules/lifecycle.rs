#![allow(dead_code)]
use crate::{
    constants,
    utils::{self, create_utf_string},
};

use std::{backtrace, env, ffi::c_void, fs, io, io::Read, panic, process};
use windows::{
    Win32::Foundation::*,
    Win32::System::{DataExchange::COPYDATASTRUCT, Threading::CreateMutexW},
    Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::*},
    core::*,
};

pub fn read_js_bundle() -> io::Result<String> {
    let current_exe = env::current_exe().unwrap();
    let dir = current_exe.parent().unwrap();

    let frontend_path = dir.join("resources/bundle.js");
    let mut js_bundle = fs::OpenOptions::new().write(true).read(true).create(true).truncate(false).open(&frontend_path)?;

    if let Ok(metadata) = js_bundle.metadata()
        && metadata.len() > 0
    {
        let mut content = String::new();
        if js_bundle.read_to_string(&mut content).is_ok() {
            return Ok(content);
        }
    }

    Err(io::Error::other("file not found, resorting to included js"))
}

fn crash_log_path() -> std::path::PathBuf {
    utils::settings_dir().join("crash_log.txt")
}

pub fn set_panic_hook() -> io::Result<()> {
    let log_file_path = crash_log_path();

    panic::set_hook(Box::new(move |panic_info| {
        crate::modules::power::put_back();
        let crash_message = format!(
            "Version: {}\n\
            Location: {}\n\
            Message: {}\n\
            \nStack Trace:\n{}\n",
            env!("CARGO_PKG_VERSION"),
            {
                let loc_string = panic_info.location().map(|loc| loc.to_string()).unwrap_or_else(|| "Unknown".to_string());
                loc_string.to_string()
            },
            panic_info
                .payload()
                .downcast_ref::<String>()
                .map(|s| s.as_str())
                .or_else(|| panic_info.payload().downcast_ref::<&str>().copied())
                .unwrap_or("<unknown>"),
            backtrace::Backtrace::force_capture()
        );

        if let Some(folder) = log_file_path.parent() {
            fs::create_dir_all(folder).ok();
        }
        fs::write(&log_file_path, &crash_message).ok();

        unsafe {
            let result = MessageBoxW(
                None,
                PCWSTR(
                    create_utf_string(format!(
                        "A crash report has been saved to:\n\
                        {}\n\n\
                        Click Yes to open the log.",
                        log_file_path.display()
                    ))
                    .as_ptr(),
                ),
                PCWSTR(create_utf_string("Application Error").as_ptr()),
                MB_YESNO | MB_ICONERROR,
            );

            if result == IDYES {
                ShellExecuteW(
                    None,
                    PCWSTR(create_utf_string("open").as_ptr()),
                    PCWSTR(create_utf_string(log_file_path.to_string_lossy()).as_ptr()),
                    PCWSTR::null(),
                    PCWSTR::null(),
                    SW_SHOW,
                );
            }
        }
    }));
    Ok(())
}

const WAIT_PID_ARG: &str = "--wait-pid=";

// spawns a client that waits for this one, then closes normally so config and profile get released
pub fn restart() {
    let args: Vec<String> = crate::LAUNCH_ARGS.lock().unwrap().clone();
    if let Ok(exe) = env::current_exe() {
        process::Command::new(exe).args(args).arg(format!("{WAIT_PID_ARG}{}", process::id())).spawn().ok();
    }
    crate::window::close_all();
}

// after restart() the old client still holds the mutex and the profile
pub fn wait_for_previous_instance() {
    let Some(pid) = env::args().find_map(|arg| arg.strip_prefix(WAIT_PID_ARG).and_then(|pid| pid.parse::<u32>().ok())) else {
        return;
    };
    unsafe {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
        if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            WaitForSingleObject(handle, 15_000);
            CloseHandle(handle).ok();
        }
    }
}

pub fn is_internal_arg(arg: &str) -> bool {
    arg.starts_with(WAIT_PID_ARG)
}

pub fn register_instance() {
    unsafe {
        CreateMutexW(None, false, PCWSTR(create_utf_string(constants::INSTANCE_MUTEX).as_ptr())).ok();

        if GetLastError() == ERROR_ALREADY_EXISTS {
            eprintln!("Instance already running");
            let data = env::args().skip(1).collect::<Vec<String>>().join(" ");

            if data.is_empty() && FindWindowW(w!("kute_webview_subwindow"), PCWSTR::null()).is_err() {
                process::exit(0);
            }
            let data_bytes = data.as_bytes();
            let copy_data = COPYDATASTRUCT {
                dwData: 0,
                cbData: data_bytes.len() as u32,
                lpData: data_bytes.as_ptr() as *mut c_void,
            };
            if let Ok(hwnd) = FindWindowExW(None, None, w!("kute_webview"), PCWSTR::null()) {
                SendMessageW(hwnd, WM_COPYDATA, Some(WPARAM(0)), Some(LPARAM(&copy_data as *const COPYDATASTRUCT as isize)));
            } else {
                SendMessageW(
                    FindWindowW(w!("kute_webview_subwindow"), PCWSTR::null()).unwrap(),
                    WM_COPYDATA,
                    None,
                    Some(LPARAM(&copy_data as *const COPYDATASTRUCT as isize)),
                );
            }
            process::exit(0);
        }
    }
}
