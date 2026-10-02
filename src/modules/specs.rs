use serde_json::{Value, json};
use windows::{
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::{Registry::*, SystemInformation::*},
    },
    core::*,
};

use crate::modules::{gpu, power};

// luids as hex strings, a u64 does not survive JSON numbers
fn luid_text(luid: u64) -> String {
    format!("{luid:x}")
}

fn wide_to_string(wide: &[u16]) -> String {
    let len = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..len]).trim().to_string()
}

unsafe extern "system" fn monitor_enum(hmonitor: HMONITOR, _: HDC, _: *mut RECT, lparam: LPARAM) -> BOOL {
    let monitors = unsafe { &mut *(lparam.0 as *mut Vec<HMONITOR>) };
    monitors.push(hmonitor);
    true.into()
}

fn displays(host: HMONITOR, adapters: &[gpu::Adapter]) -> Vec<Value> {
    let mut monitors: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(monitor_enum), LPARAM(&mut monitors as *mut _ as isize));
    }

    monitors
        .into_iter()
        .filter_map(|hmonitor| {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
            unsafe {
                if !GetMonitorInfoW(hmonitor, &mut info.monitorInfo as *mut MONITORINFO).as_bool() {
                    return None;
                }
            }
            let mut mode = DEVMODEW {
                dmSize: size_of::<DEVMODEW>() as u16,
                ..Default::default()
            };
            unsafe {
                if !EnumDisplaySettingsW(PCWSTR(info.szDevice.as_ptr()), ENUM_CURRENT_SETTINGS, &mut mode).as_bool() {
                    return None;
                }
            }
            // MONITORINFOF_PRIMARY
            let primary = info.monitorInfo.dwFlags & 1 != 0;
            Some(json!({
                "name": wide_to_string(&info.szDevice),
                "width": mode.dmPelsWidth,
                "height": mode.dmPelsHeight,
                "hz": mode.dmDisplayFrequency,
                "primary": primary,
                "hostsWindow": hmonitor == host,
                // the adapter this display is wired to, null when no adapter lists it
                "adapter": adapters.iter().find(|adapter| adapter.outputs.contains(&(hmonitor.0 as isize))).map(|adapter| luid_text(adapter.luid)),
            }))
        })
        .collect()
}

fn gpus(adapters: &[gpu::Adapter]) -> Vec<Value> {
    adapters
        .iter()
        .map(|adapter| {
            json!({
                "name": adapter.name,
                "vramMb": adapter.vram_mb,
                "vendorId": adapter.vendor_id,
                "software": adapter.software,
                "luid": luid_text(adapter.luid),
            })
        })
        .collect()
}

fn cpu_name() -> String {
    let mut buf = [0u16; 256];
    let mut size = (buf.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0"),
            w!("ProcessorNameString"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
    };
    if status == ERROR_SUCCESS { wide_to_string(&buf) } else { String::new() }
}

fn ram_mb() -> u64 {
    let mut status = MEMORYSTATUSEX {
        dwLength: size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    match unsafe { GlobalMemoryStatusEx(&mut status) } {
        Ok(()) => status.ullTotalPhys / (1024 * 1024),
        Err(_) => 0,
    }
}

// e.g. "26200", the presentation path differs between builds
fn os_build() -> String {
    let mut buf = [0u16; 32];
    let mut size = (buf.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
            w!("CurrentBuildNumber"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
    };
    if status == ERROR_SUCCESS { wide_to_string(&buf) } else { String::new() }
}

pub fn collect(hwnd: HWND) -> Value {
    let (laptop, on_battery) = power::battery();
    let (user_flags, disabled_defaults) = crate::modules::flaglist::user_flag_names();
    let adapters = gpu::adapters();
    let host = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let topology = gpu::topology(host, &adapters);
    let render = topology.render.map(|luid| {
        json!({
            "luid": luid_text(luid),
            "name": adapters.iter().find(|adapter| adapter.luid == luid).map(|adapter| adapter.name.as_str()),
        })
    });
    json!({
        "osBuild": os_build(),
        // names only, values can contain user paths
        "userFlags": user_flags,
        "disabledDefaults": disabled_defaults,
        "displays": displays(host, &adapters),
        "gpus": gpus(&adapters),
        // the adapter the game renders on. hybridSource "observed": read from the game's swap chain (hook on),
        // "inferred": windows' preference order, "unknown": hybrid is null and nothing may be decided from it
        "renderAdapter": render,
        "hybrid": topology.hybrid(),
        "hybridSource": topology.source(),
        "powerOverlay": power::overlay_name(),
        "cpu": {
            "name": cpu_name(),
            "threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        },
        "ramMb": ram_mb(),
        "laptop": laptop,
        "onBattery": on_battery,
    })
}
