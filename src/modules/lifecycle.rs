#![allow(dead_code)]
use crate::utils;
#[cfg(windows)]
use crate::{constants, utils::create_utf_string};

#[cfg(windows)]
use std::ffi::c_void;
use std::{backtrace, env, fs, io, io::Read, panic, process};
#[cfg(windows)]
use windows::{
    Win32::Foundation::*,
    Win32::Storage::FileSystem::{CREATE_ALWAYS, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_WRITE, FILE_SHARE_NONE},
    Win32::System::Diagnostics::Debug::*,
    Win32::System::LibraryLoader::{
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, GetModuleFileNameW, GetModuleHandleExW,
    },
    Win32::System::{
        DataExchange::COPYDATASTRUCT,
        Threading::{CreateMutexW, GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId},
    },
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

// a crash inside libcef or a driver is no rust panic: the panic hook never runs and the client just vanishes
// (three "it randomly closes" reports without a crash_log.txt, 2026-10-09)
#[cfg(windows)]
pub fn set_crash_filter() {
    unsafe {
        SetUnhandledExceptionFilter(Some(crash_filter));
    }
}

#[cfg(windows)]
unsafe extern "system" fn crash_filter(info: *const EXCEPTION_POINTERS) -> i32 {
    use std::sync::atomic::{AtomicBool, Ordering};
    static ONCE: AtomicBool = AtomicBool::new(false);
    if ONCE.swap(true, Ordering::SeqCst) {
        return EXCEPTION_CONTINUE_SEARCH;
    }
    unsafe {
        crate::modules::power::put_back();
        let record = if info.is_null() { std::ptr::null() } else { (*info).ExceptionRecord };
        let (code, address) = if record.is_null() {
            (0u32, 0usize)
        } else {
            ((*record).ExceptionCode.0 as u32, (*record).ExceptionAddress as usize)
        };
        let dir = utils::settings_dir();
        fs::create_dir_all(&dir).ok();
        let dump_path = dir.join("crash.dmp");
        let dumped = write_minidump(&dump_path, info);
        let log_path = crash_log_path();
        let message = format!(
            "Version: {}\nNative crash, not a rust panic\nException: {code:#010x}\nAddress: {}\nThread: {}\nMinidump: {}\n",
            env!("CARGO_PKG_VERSION"),
            module_offset(address),
            GetCurrentThreadId(),
            if dumped { dump_path.display().to_string() } else { "not written".to_string() },
        );
        fs::write(&log_path, &message).ok();
        if crate::modules::recovery::on_crash(&format!("native {code:#010x} at {}", module_offset(address))) {
            return EXCEPTION_CONTINUE_SEARCH;
        }
        let result = MessageBoxW(
            None,
            PCWSTR(
                create_utf_string(format!(
                    "Kute crashed. A crash report has been saved to:\n\
                    {}\n\n\
                    Click Yes to open the log.",
                    log_path.display()
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
                PCWSTR(create_utf_string(log_path.to_string_lossy()).as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOW,
            );
        }
    }
    EXCEPTION_CONTINUE_SEARCH
}

#[cfg(windows)]
unsafe fn module_offset(address: usize) -> String {
    let mut module = HMODULE::default();
    let flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
    if address == 0 || unsafe { GetModuleHandleExW(flags, PCWSTR(address as *const u16), &mut module) }.is_err() {
        return format!("{address:#x}");
    }
    let mut name = [0u16; 260];
    let len = unsafe { GetModuleFileNameW(Some(module), &mut name) } as usize;
    let path = String::from_utf16_lossy(&name[..len]);
    let file = path.rsplit(['\\', '/']).next().unwrap_or(&path);
    format!("{file}+{:#x} ({address:#x})", address - module.0 as usize)
}

// stacks, threads and the module list, a few MB, stays on the pc like crash_log.txt
#[cfg(windows)]
unsafe fn write_minidump(path: &std::path::Path, info: *const EXCEPTION_POINTERS) -> bool {
    unsafe {
        let Ok(file) = CreateFileW(
            PCWSTR(create_utf_string(path.to_string_lossy()).as_ptr()),
            FILE_GENERIC_WRITE.0,
            FILE_SHARE_NONE,
            None,
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            None,
        ) else {
            return false;
        };
        let exception = MINIDUMP_EXCEPTION_INFORMATION {
            ThreadId: GetCurrentThreadId(),
            ExceptionPointers: info as *mut EXCEPTION_POINTERS,
            ClientPointers: false.into(),
        };
        let exception_param = (!info.is_null()).then_some(&exception as *const MINIDUMP_EXCEPTION_INFORMATION);
        let result = MiniDumpWriteDump(
            GetCurrentProcess(),
            GetCurrentProcessId(),
            file,
            MiniDumpNormal | MiniDumpWithThreadInfo,
            exception_param,
            None,
            None,
        );
        CloseHandle(file).ok();
        result.is_ok()
    }
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
        let location = panic_info.location().map(|loc| loc.to_string()).unwrap_or_default();
        if crate::modules::recovery::on_crash(&format!("panic at {location}")) {
            return;
        }

        #[cfg(windows)]
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
    // inside an AppImage current_exe is the temporary mount, the file to start again is $APPIMAGE
    #[cfg(target_os = "linux")]
    let exe = env::var_os("APPIMAGE").map(std::path::PathBuf::from).ok_or(()).or_else(|_| env::current_exe());
    #[cfg(windows)]
    let exe = env::current_exe();
    if let Ok(exe) = exe {
        // the new client decides its own session overrides
        process::Command::new(exe)
            .args(args)
            .arg(wait_pid_arg())
            .env_remove(crate::modules::recovery::ENV)
            .spawn()
            .ok();
    }
    crate::window::close_all();
}

// after restart() the old client still holds the mutex and the profile
pub fn wait_for_previous_instance() {
    let Some(pid) = env::args().find_map(|arg| arg.strip_prefix(WAIT_PID_ARG).and_then(|pid| pid.parse::<u32>().ok())) else {
        return;
    };
    #[cfg(target_os = "linux")]
    crate::linux::instance::wait_for(pid);
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
        if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            WaitForSingleObject(handle, 15_000);
            CloseHandle(handle).ok();
        }
    }
}

pub fn wait_pid_arg() -> String {
    format!("{WAIT_PID_ARG}{}", process::id())
}

pub fn is_internal_arg(arg: &str) -> bool {
    arg.starts_with(WAIT_PID_ARG)
}

#[cfg(target_os = "linux")]
pub fn register_instance() {
    crate::linux::instance::register();
}

#[cfg(windows)]
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
