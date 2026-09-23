//! Diagnostics build (`--features diag-log`): every `debug_print!` line of every process goes to
//! `Downloads\kute-diagnostics.log`, plus what is needed to see why a PC behaves differently: the system specs,
//! the client settings, Chromium's own GPU report (what chrome://gpu shows) and, from render.dll and the page,
//! every swap chain and how often it presents next to the game's own frame rate.
//!
//! The browser process picks the file and hands it to every child process through KUTE_DIAG_LOG (render.dll
//! reads the same variable). In a normal build nothing sets it and `log` returns at once; `debug_print!` is not
//! even compiled in without `verbose-logs`.

use std::{
    fs::OpenOptions,
    io::Write,
    sync::{LazyLock, Mutex},
};

use cef::*;

use crate::{debug_print, modules::specs, utils};

pub const ENV: &str = "KUTE_DIAG_LOG";

// one write per line and a lock per process; lines of different processes interleave, each carries its pid
static FILE: LazyLock<Option<Mutex<std::fs::File>>> = LazyLock::new(|| {
    let path = std::env::var(ENV).ok()?;
    OpenOptions::new().create(true).append(true).open(path).ok().map(Mutex::new)
});

static PROCESS: LazyLock<String> = LazyLock::new(|| {
    let kind = utils::process_type().unwrap_or_else(|| "browser".to_string());
    format!("{kind:>9} {:>6}", std::process::id())
});

fn clock() -> String {
    // local time: a player says "around nine", not in UTC
    let time = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    format!("{:02}:{:02}:{:02}.{:03}", time.wHour, time.wMinute, time.wSecond, time.wMilliseconds)
}

pub fn log(message: &str) {
    let Some(file) = FILE.as_ref() else { return };
    if let Ok(mut file) = file.lock() {
        let _ = writeln!(file, "{} {} {message}", clock(), *PROCESS);
    }
}

/// Browser process, before anything else: chooses the file (the last one is kept as .old) and tells every
/// process started from now on where it is.
pub fn init() {
    if !cfg!(feature = "diag-log") || utils::process_type().is_some() {
        return;
    }
    let path = utils::downloads_dir().join("kute-diagnostics.log");
    if path.exists() {
        let _ = std::fs::rename(&path, path.with_extension("old.log"));
    }
    // SAFETY: the browser process sets it before it starts a single thread or child process
    unsafe {
        std::env::set_var(ENV, &path);
    }
    log(&format!("Kute {} diagnostics build", env!("CARGO_PKG_VERSION")));
}

/// Once the main browser exists: specs and settings. (Chromium's GPU report, SystemInfo.getInfo, is only served
/// on the browser target, a page cannot ask for it. render.dll logs the facts it is made of instead: adapters,
/// hardware overlay support per format, HDR.)
pub fn on_main_browser(_browser: &Browser, hwnd: windows::Win32::Foundation::HWND) {
    if !cfg!(feature = "diag-log") {
        return;
    }
    debug_print!("diag: specs {}", specs::collect(hwnd));
    debug_print!("diag: settings {}", serde_json::json!(&*crate::CONFIG.lock().unwrap()));
}

/// Where Chromium's own log goes: next to ours in the diagnostics build.
pub fn cef_log_file() -> Option<std::path::PathBuf> {
    cfg!(feature = "diag-log").then(|| utils::downloads_dir().join("kute-diagnostics-chromium.log"))
}
