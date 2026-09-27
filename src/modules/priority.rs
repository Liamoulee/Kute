use std::mem;
use windows::Win32::{
    Foundation::*,
    System::{Diagnostics::ToolHelp::*, SystemInformation::*, Threading::*},
};

use crate::{debug_print, utils::config};

fn priority_class(level: &str) -> PROCESS_CREATION_FLAGS {
    match level {
        "High" => HIGH_PRIORITY_CLASS,
        "Above Normal" => ABOVE_NORMAL_PRIORITY_CLASS,
        "Below Normal" => BELOW_NORMAL_PRIORITY_CLASS,
        "Idle" => IDLE_PRIORITY_CLASS,
        _ => NORMAL_PRIORITY_CLASS,
    }
}

// HighQoS: windows guesses no EcoQoS for our windowless processes (renderer, gpu) or on battery, timer resolution stays
// honored. chromium still moves its background renderers to EcoQoS itself. neutral on a 12900K, meant for the other PCs
pub fn high_qos_self() {
    let state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION,
        StateMask: 0,
    };
    unsafe {
        SetProcessInformation(
            GetCurrentProcess(),
            ProcessPowerThrottling,
            (&state as *const PROCESS_POWER_THROTTLING_STATE).cast(),
            mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        )
        .ok();
    }
}

// subprocesses call this so late spawned ones get it too
pub fn apply_to_self() {
    let level = config("webviewPriority", "Normal".to_string());
    if level == "Normal" {
        return;
    }
    unsafe {
        SetPriorityClass(GetCurrentProcess(), priority_class(&level)).ok();
    }
}

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

// (size, processor group, mask) of every L3 cache
fn l3_caches() -> Option<Vec<(u32, u16, usize)>> {
    unsafe {
        let mut len = 0u32;
        let _ = GetLogicalProcessorInformationEx(RelationCache, None, &mut len);
        if len == 0 {
            return None;
        }
        // u64 storage, the records need 8 byte alignment
        let mut buffer = vec![0u64; (len as usize).div_ceil(8)];
        GetLogicalProcessorInformationEx(RelationCache, Some(buffer.as_mut_ptr().cast()), &mut len).ok()?;
        let base = buffer.as_ptr().cast::<u8>();
        let mut caches = Vec::new();
        let mut offset = 0usize;
        while offset + mem::size_of::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>() <= len as usize {
            let info = &*base.add(offset).cast::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>();
            if info.Size == 0 {
                break;
            }
            if info.Relationship == RelationCache {
                let cache = &info.Anonymous.Cache;
                if cache.Level == 3 && cache.Type == CacheUnified {
                    let group = cache.Anonymous.GroupMask;
                    caches.push((cache.CacheSize, group.Group, group.Mask));
                }
            }
            offset += info.Size as usize;
        }
        Some(caches)
    }
}

// the cores of the largest L3 when the L3s differ in size (Ryzen X3D with two CCDs). one L3 or equal ones: nothing to prefer
fn pick_cache_cores(caches: &[(u32, u16, usize)]) -> Option<usize> {
    if caches.len() < 2 || caches.iter().any(|&(_, group, _)| group != 0) {
        return None;
    }
    let &(largest, _, mask) = caches.iter().max_by_key(|&&(size, _, _)| size)?;
    if caches.iter().all(|&(size, _, _)| size == largest) {
        return None;
    }
    Some(mask)
}

// before cef starts, the child processes inherit it. a 7950X3D tester landed in the steady mode (1 % low 1429 instead of
// ~450) in 6 of 8 starts on the cache cores, 3 to 4 of 8 left to windows, which keeps only recognized games there
pub fn prefer_cache_cores() {
    if !config("x3dCacheCores", true) {
        return;
    }
    let Some(mask) = l3_caches().as_deref().and_then(pick_cache_cores) else {
        return;
    };
    unsafe {
        let (mut current, mut system) = (0usize, 0usize);
        if GetProcessAffinityMask(GetCurrentProcess(), &mut current, &mut system).is_err() {
            return;
        }
        // a mask someone set on purpose (Task Manager, a tuning tool) stays the outer limit
        let wanted = mask & current;
        if wanted == 0 || wanted == current {
            return;
        }
        match SetProcessAffinityMask(GetCurrentProcess(), wanted) {
            Ok(()) => debug_print!("priority: kept on the largest L3, affinity {current:#x} -> {wanted:#x}"),
            Err(_e) => debug_print!("priority: cache core affinity {wanted:#x} refused: {_e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::pick_cache_cores;

    #[test]
    fn picks_the_bigger_cache_on_x3d() {
        // 7950X3D: CCD0 96 MB with threads 0-15, CCD1 32 MB with 16-31
        assert_eq!(pick_cache_cores(&[(96 << 20, 0, 0xFFFF), (32 << 20, 0, 0xFFFF_0000)]), Some(0xFFFF));
        assert_eq!(pick_cache_cores(&[(32 << 20, 0, 0xFFFF), (96 << 20, 0, 0xFFFF_0000)]), Some(0xFFFF_0000));
    }

    #[test]
    fn leaves_everything_else_alone() {
        assert_eq!(pick_cache_cores(&[(30 << 20, 0, 0xFF_FFFF)]), None);
        assert_eq!(pick_cache_cores(&[(32 << 20, 0, 0xFFFF), (32 << 20, 0, 0xFFFF_0000)]), None);
        assert_eq!(pick_cache_cores(&[(96 << 20, 0, 0xFFFF), (32 << 20, 1, 0xFFFF)]), None);
        assert_eq!(pick_cache_cores(&[]), None);
    }
}
