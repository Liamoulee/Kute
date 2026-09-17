use std::mem;
use windows::Win32::{
    Foundation::*,
    System::{Diagnostics::ToolHelp::*, Threading::*},
};

use crate::utils::config;

fn priority_class(level: &str) -> PROCESS_CREATION_FLAGS {
    match level {
        "High" => HIGH_PRIORITY_CLASS,
        "Above Normal" => ABOVE_NORMAL_PRIORITY_CLASS,
        "Below Normal" => BELOW_NORMAL_PRIORITY_CLASS,
        "Idle" => IDLE_PRIORITY_CLASS,
        _ => NORMAL_PRIORITY_CLASS,
    }
}

// subprocesses call this on startup so later spawned renderers and utilities get it too
pub fn apply_to_self() {
    let level = config("webviewPriority", "Normal".to_string());
    if level == "Normal" {
        return;
    }
    unsafe {
        SetPriorityClass(GetCurrentProcess(), priority_class(&level)).ok();
    }
}

// the browser process plus every CEF subprocess it spawned
pub fn set(level: impl AsRef<str>) {
    let priority_class = priority_class(level.as_ref());

    unsafe {
        let current_pid = GetCurrentProcessId();
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).unwrap();
        let mut entry = PROCESSENTRY32W {
            dwSize: mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ParentProcessID == current_pid
                    && let Ok(handle) = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION, false, entry.th32ProcessID)
                {
                    SetPriorityClass(handle, priority_class).ok();
                    CloseHandle(handle).ok();
                }

                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        CloseHandle(snapshot).ok();
        SetPriorityClass(GetCurrentProcess(), priority_class).ok();
    };
}
