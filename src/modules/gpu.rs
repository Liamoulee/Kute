use windows::{
    Win32::{
        Foundation::*,
        Graphics::{Dxgi::*, Gdi::*},
        System::Registry::*,
    },
    core::*,
};

use crate::{CONFIG, app, debug_print, utils};

pub struct Adapter {
    pub luid: u64,
    pub name: String,
    pub vram_mb: u64,
    pub vendor_id: u32,
    pub software: bool,
    // HMONITORs of the displays wired to this adapter
    pub outputs: Vec<isize>,
}

fn luid(value: LUID) -> u64 {
    ((value.HighPart as u32 as u64) << 32) | value.LowPart as u64
}

fn wide_to_string(wide: &[u16]) -> String {
    let len = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..len]).trim().to_string()
}

pub fn adapters() -> Vec<Adapter> {
    let mut out = Vec::new();
    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return out;
    };
    let mut index = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
        index += 1;
        let Ok(desc) = (unsafe { adapter.GetDesc1() }) else {
            continue;
        };
        let mut outputs = Vec::new();
        let mut output_index = 0;
        while let Ok(output) = unsafe { adapter.EnumOutputs(output_index) } {
            output_index += 1;
            if let Ok(output_desc) = unsafe { output.GetDesc() } {
                outputs.push(output_desc.Monitor.0 as isize);
            }
        }
        out.push(Adapter {
            luid: luid(desc.AdapterLuid),
            name: wide_to_string(&desc.Description),
            vram_mb: (desc.DedicatedVideoMemory / (1024 * 1024)) as u64,
            vendor_id: desc.VendorId,
            software: desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0,
            outputs,
        });
    }
    out
}

// what --force-high-performance-gpu makes chromium ask for. an order of preference, not the device the game runs on
fn preferred_adapter() -> Option<u64> {
    unsafe {
        let factory = CreateDXGIFactory1::<IDXGIFactory6>().ok()?;
        let adapter = factory.EnumAdapterByGpuPreference::<IDXGIAdapter1>(0, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE).ok()?;
        Some(luid(adapter.GetDesc1().ok()?.AdapterLuid))
    }
}

pub struct Topology {
    // adapter the monitor is wired to
    pub display: Option<u64>,
    pub render: Option<u64>,
    // render adapter read from the game's own swap chain (hook on), else windows' preference order
    pub observed: bool,
}

impl Topology {
    // frames get copied between two gpus. None: not enough known to say
    pub fn hybrid(&self) -> Option<bool> {
        Some(self.display? != self.render?)
    }

    pub fn source(&self) -> &'static str {
        match (self.hybrid(), self.observed) {
            (None, _) => "unknown",
            (Some(_), true) => "observed",
            (Some(_), false) => "inferred",
        }
    }
}

pub fn topology(monitor: HMONITOR, adapters: &[Adapter]) -> Topology {
    let display = adapters
        .iter()
        .find(|adapter| adapter.outputs.contains(&(monitor.0 as isize)))
        .map(|adapter| adapter.luid);
    let observed = app::render_adapter();
    Topology {
        display,
        render: if observed != 0 { Some(observed) } else { preferred_adapter() },
        observed: observed != 0,
    }
}

const DONE_SETTING: &str = "hybridDefaultsApplied";
// what the first look found, so later starts need no dxgi
const HYBRID_SETTING: &str = "hybridSystem";

// before cef starts: a laptop that renders on one gpu and shows on the other. the hook default once per pc, windows'
// gpu preference on every start: it belongs to the exe's path, and a kute that was moved, unzipped somewhere else or
// installed after a portable build had none (the marker said "done")
pub fn apply_hybrid_defaults() {
    let done = utils::config(DONE_SETTING, false);
    let known = CONFIG.lock().unwrap().get::<bool>(HYBRID_SETTING);
    let hybrid = match known {
        Some(hybrid) => hybrid,
        None => {
            let monitor = unsafe { MonitorFromPoint(POINT::default(), MONITOR_DEFAULTTOPRIMARY) };
            // unknown: asked again on the next start
            let Some(hybrid) = topology(monitor, &adapters()).hybrid() else {
                return;
            };
            hybrid
        }
    };
    if hybrid {
        prefer_high_performance_gpu();
    }
    if done && known.is_some() {
        return;
    }
    let mut config = CONFIG.lock().unwrap();
    if hybrid && !done {
        // obs capture needs the hook, a player who uses it keeps it. the present fps counter only loses its second number
        let needs_hook = config.get::<bool>("obsCapturePlugin") == Some(true);
        if !needs_hook {
            // a tester's hybrid laptop: 707 fps with the hook, 1397 without, on the bench scene
            config.set("hardFlip", false);
        }
        debug_print!(
            "gpu: hybrid graphics, hook {}",
            if needs_hook { "kept (capture in use)" } else { "off by default" }
        );
    }
    config.set(DONE_SETTING, true);
    config.set(HYBRID_SETTING, hybrid);
    config.save();
}

// windows' per app "high performance" choice (Settings, Display, Graphics), which players were told to set by hand.
// left alone when the player already chose something for this exe
fn prefer_high_performance_gpu() {
    let Ok(exe) = std::env::current_exe() else { return };
    let name = HSTRING::from(exe.as_os_str());
    let key = w!("Software\\Microsoft\\DirectX\\UserGpuPreferences");
    unsafe {
        if RegGetValueW(HKEY_CURRENT_USER, key, &name, RRF_RT_REG_SZ, None, None, None) == ERROR_SUCCESS {
            return;
        }
        let value: Vec<u16> = "GpuPreference=2;".encode_utf16().chain(Some(0)).collect();
        let status = RegSetKeyValueW(
            HKEY_CURRENT_USER,
            key,
            &name,
            REG_SZ.0,
            Some(value.as_ptr() as *const _),
            (value.len() * 2) as u32,
        );
        debug_print!("gpu: high performance preference for kute.exe, status {status:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::Topology;

    #[test]
    fn two_gpus_are_hybrid_only_when_known() {
        let igpu = Some(0x1_0000);
        let dgpu = Some(0x2_0000);
        // laptop panel on the igpu, game on the dgpu
        let hybrid = Topology {
            display: igpu,
            render: dgpu,
            observed: true,
        };
        assert_eq!(hybrid.hybrid(), Some(true));
        assert_eq!(hybrid.source(), "observed");
        // mux in dgpu mode, an external monitor on the dgpu port, or a desktop
        let direct = Topology {
            display: dgpu,
            render: dgpu,
            observed: false,
        };
        assert_eq!(direct.hybrid(), Some(false));
        assert_eq!(direct.source(), "inferred");
    }

    #[test]
    fn a_missing_side_is_unknown_not_hybrid() {
        let no_display = Topology {
            display: None,
            render: Some(1),
            observed: true,
        };
        assert_eq!(no_display.hybrid(), None);
        assert_eq!(no_display.source(), "unknown");
        let no_render = Topology {
            display: Some(1),
            render: None,
            observed: false,
        };
        assert_eq!(no_render.hybrid(), None);
        assert_eq!(no_render.source(), "unknown");
    }
}
