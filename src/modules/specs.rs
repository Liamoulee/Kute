// hardware facts for the auto-detect run (frontend/modules/autoDetect): what the page cannot find out itself
use serde_json::{Value, json};
use windows::{
    Win32::{
        Foundation::*,
        Graphics::{Dxgi::*, Gdi::*},
        System::{Power::*, Registry::*, SystemInformation::*},
    },
    core::*,
};

fn wide_to_string(wide: &[u16]) -> String {
    let len = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..len]).trim().to_string()
}

unsafe extern "system" fn monitor_enum(hmonitor: HMONITOR, _: HDC, _: *mut RECT, lparam: LPARAM) -> BOOL {
    let monitors = unsafe { &mut *(lparam.0 as *mut Vec<HMONITOR>) };
    monitors.push(hmonitor);
    true.into()
}

fn displays(hwnd: HWND) -> Vec<Value> {
    let mut monitors: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(monitor_enum), LPARAM(&mut monitors as *mut _ as isize));
    }
    let host = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };

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
            }))
        })
        .collect()
}

fn gpus() -> Vec<Value> {
    let mut out = Vec::new();
    let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
        Ok(f) => f,
        Err(_) => return out,
    };
    let mut index = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
        index += 1;
        let Ok(desc) = (unsafe { adapter.GetDesc1() }) else {
            continue;
        };
        out.push(json!({
            "name": wide_to_string(&desc.Description),
            "vramMb": desc.DedicatedVideoMemory / (1024 * 1024),
            "vendorId": desc.VendorId,
            "software": desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0,
        }));
    }
    out
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

fn power() -> (bool, bool) {
    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
        return (false, false);
    }
    // BatteryFlag 128 = no system battery, 255 = unknown
    let laptop = status.BatteryFlag & 128 == 0 && status.BatteryFlag != 255;
    let on_battery = laptop && status.ACLineStatus == 0;
    (laptop, on_battery)
}

pub fn collect(hwnd: HWND) -> Value {
    let (laptop, on_battery) = power();
    json!({
        "displays": displays(hwnd),
        "gpus": gpus(),
        "cpu": {
            "name": cpu_name(),
            "threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        },
        "ramMb": ram_mb(),
        "laptop": laptop,
        "onBattery": on_battery,
    })
}
