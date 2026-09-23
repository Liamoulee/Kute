//! Only in the diagnostics build (feature `diagnostics`): finds out what the GPU process really presents on a PC
//! where the hook does not see the game's frames. Every line goes to the file the client names in KUTE_DIAG_LOG.
//!
//! - every swap chain that presents: its size, how it was made, how often it presents through Present1 and
//!   through Present, whether the hook prepared it and whether it counts as the game's (MAIN_SWAPCHAIN), every 5 s
//! - swap chains made through CreateSwapChainForHwnd and CreateSwapChain, which the normal hook never looks at
//! - the adapters, and per display whether it can put overlays on the screen (MPO), which decides whether
//!   Chromium promotes content out of the swap chain at all
//!
//! Nothing here changes a call: the extra hooks count and log and hand everything to the original.

use std::{
    collections::HashMap,
    ffi::c_void,
    fs::{File, OpenOptions},
    io::Write,
    mem,
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

use minhook::MinHook;
use windows::Win32::{
    Foundation::*,
    Graphics::{
        Direct3D::*,
        Direct3D11::*,
        Dxgi::{Common::*, *},
    },
};
use windows::core::*;

static FILE: LazyLock<Option<Mutex<File>>> = LazyLock::new(|| {
    let path = std::env::var("KUTE_DIAG_LOG").ok()?;
    OpenOptions::new().create(true).append(true).open(path).ok().map(Mutex::new)
});

fn clock() -> String {
    // local time: a player says "around nine", not in UTC
    let time = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    format!("{:02}:{:02}:{:02}.{:03}", time.wHour, time.wMinute, time.wSecond, time.wMilliseconds)
}

pub fn log(message: &str) {
    let Some(file) = FILE.as_ref() else { return };
    if let Ok(mut file) = file.lock() {
        let _ = writeln!(file, "{} render.dll {:>6} {message}", clock(), std::process::id());
    }
}

struct Chain {
    width: u32,
    height: u32,
    format: i32,
    made_by: &'static str,
    present1: u64,
    present: u64,
    windows_silent: u32,
}

static CHAINS: LazyLock<Mutex<HashMap<usize, Chain>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
// how swap chains were made, by pointer, from the create hooks (a chain presents only after it exists)
static MADE_BY: LazyLock<Mutex<HashMap<usize, &'static str>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static START: LazyLock<Instant> = LazyLock::new(Instant::now);
static LAST_DUMP_MS: AtomicU64 = AtomicU64::new(0);
const DUMP_EVERY_MS: u64 = 5000;

fn describe(chain: *mut c_void) -> Chain {
    let made_by = MADE_BY.lock().unwrap().get(&(chain as usize)).copied().unwrap_or("before the hooks / unknown");
    let mut described = Chain {
        width: 0,
        height: 0,
        format: 0,
        made_by,
        present1: 0,
        present: 0,
        windows_silent: 0,
    };
    unsafe {
        if let Some(swap_chain) = IDXGISwapChain::from_raw_borrowed(&chain)
            && let Ok(desc) = swap_chain.GetDesc()
        {
            described.width = desc.BufferDesc.Width;
            described.height = desc.BufferDesc.Height;
            described.format = desc.BufferDesc.Format.0;
        }
    }
    described
}

/// Called for every present of every swap chain. `plain`: through Present instead of Present1.
pub fn present(chain: *mut c_void, plain: bool) {
    {
        let mut chains = CHAINS.lock().unwrap();
        let entry = chains.entry(chain as usize).or_insert_with(|| describe(chain));
        if plain {
            entry.present += 1;
        } else {
            entry.present1 += 1;
        }
    }
    let now = START.elapsed().as_millis() as u64;
    let last = LAST_DUMP_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) >= DUMP_EVERY_MS && LAST_DUMP_MS.compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed).is_ok() {
        dump(now.saturating_sub(last).max(1));
    }
}

fn dump(window_ms: u64) {
    let main = crate::MAIN_SWAPCHAIN.load(Ordering::Relaxed);
    let prepared: Vec<usize> = crate::WAIT_HANDLE.read().map(|handles| handles.keys().copied().collect()).unwrap_or_default();
    let mut chains = CHAINS.lock().unwrap();
    let per_second = |count: u64| (count * 1000) as f64 / window_ms as f64;
    let mut lines = Vec::new();
    for (pointer, chain) in chains.iter_mut() {
        if chain.present1 == 0 && chain.present == 0 {
            chain.windows_silent += 1;
            continue;
        }
        chain.windows_silent = 0;
        lines.push(format!(
            "diag: chain {pointer:#x} {}x{} format {} made by {} | Present1 {:.1}/s Present {:.1}/s | prepared {} | game's {}",
            chain.width,
            chain.height,
            chain.format,
            chain.made_by,
            per_second(chain.present1),
            per_second(chain.present),
            prepared.contains(pointer),
            *pointer == main,
        ));
        chain.present1 = 0;
        chain.present = 0;
    }
    // chains that stopped presenting a while ago are gone (Chromium makes a new one on every resize)
    chains.retain(|_, chain| chain.windows_silent < 6);
    let silent = chains.values().filter(|chain| chain.windows_silent > 0).count();
    drop(chains);
    log(&format!(
        "diag: --- presents over the last {:.1} s, {} chain(s) silent, game's chain {main:#x}",
        window_ms as f64 / 1000.0,
        silent
    ));
    for line in lines {
        log(&line);
    }
}

// ---- the extra hooks: they only count and log ----

type PresentFn = unsafe extern "system" fn(*mut c_void, u32, DXGI_PRESENT) -> HRESULT;
type CreateForHwndFn = unsafe extern "system" fn(
    *mut c_void,
    *mut c_void,
    HWND,
    *const DXGI_SWAP_CHAIN_DESC1,
    *const DXGI_SWAP_CHAIN_FULLSCREEN_DESC,
    *mut c_void,
    *mut *mut c_void,
) -> HRESULT;
type CreateFn = unsafe extern "system" fn(*mut c_void, *mut c_void, *const DXGI_SWAP_CHAIN_DESC, *mut *mut c_void) -> HRESULT;

static mut ORIGINAL_PLAIN_PRESENT: Option<PresentFn> = None;
static mut ORIGINAL_CREATE_FOR_HWND: Option<CreateForHwndFn> = None;
static mut ORIGINAL_CREATE: Option<CreateFn> = None;

unsafe extern "system" fn plain_present_hk(this: *mut c_void, sync_interval: u32, flags: DXGI_PRESENT) -> HRESULT {
    present(this, true);
    unsafe { ORIGINAL_PLAIN_PRESENT.unwrap()(this, sync_interval, flags) }
}

unsafe extern "system" fn create_for_hwnd_hk(
    this: *mut c_void,
    device: *mut c_void,
    hwnd: HWND,
    desc: *const DXGI_SWAP_CHAIN_DESC1,
    fullscreen: *const DXGI_SWAP_CHAIN_FULLSCREEN_DESC,
    output: *mut c_void,
    swap_chain: *mut *mut c_void,
) -> HRESULT {
    let result = unsafe { ORIGINAL_CREATE_FOR_HWND.unwrap()(this, device, hwnd, desc, fullscreen, output, swap_chain) };
    unsafe {
        let (width, height) = desc.as_ref().map(|d| (d.Width, d.Height)).unwrap_or_default();
        log(&format!(
            "diag: CreateSwapChainForHwnd {width}x{height} hwnd {:?} result {:#x}",
            hwnd.0, result.0
        ));
        if result.is_ok() && !swap_chain.is_null() {
            MADE_BY.lock().unwrap().insert(*swap_chain as usize, "CreateSwapChainForHwnd");
        }
    }
    result
}

unsafe extern "system" fn create_hk(this: *mut c_void, device: *mut c_void, desc: *const DXGI_SWAP_CHAIN_DESC, swap_chain: *mut *mut c_void) -> HRESULT {
    let result = unsafe { ORIGINAL_CREATE.unwrap()(this, device, desc, swap_chain) };
    unsafe {
        let (width, height) = desc.as_ref().map(|d| (d.BufferDesc.Width, d.BufferDesc.Height)).unwrap_or_default();
        log(&format!("diag: CreateSwapChain {width}x{height} result {:#x}", result.0));
        if result.is_ok() && !swap_chain.is_null() {
            MADE_BY.lock().unwrap().insert(*swap_chain as usize, "CreateSwapChain");
        }
    }
    result
}

/// Remembers how a chain made through the regular hook was made (create_swapchain_hk calls this).
pub fn made_for_composition(swap_chain: *mut c_void, prepared: bool) {
    let label = if prepared {
        "CreateSwapChainForComposition (prepared)"
    } else {
        "CreateSwapChainForComposition (left alone)"
    };
    MADE_BY.lock().unwrap().insert(swap_chain as usize, label);
}

/// Next to the regular hooks, before they get enabled: the three counting hooks, and what the machine has.
pub unsafe fn attach(factory: &IDXGIFactory2, swap_chain: &IDXGISwapChain1) {
    log(&format!("diag: render.dll attached, os build {}", os_build()));
    describe_adapters(factory);
    unsafe {
        match MinHook::create_hook(swap_chain.vtable().base__.Present as *mut c_void, plain_present_hk as *mut c_void) {
            Ok(original) => ORIGINAL_PLAIN_PRESENT = Some(mem::transmute::<*mut c_void, PresentFn>(original)),
            Err(e) => log(&format!("diag: Present hook failed: {e:?}")),
        }
        match MinHook::create_hook(factory.vtable().CreateSwapChainForHwnd as *mut c_void, create_for_hwnd_hk as *mut c_void) {
            Ok(original) => ORIGINAL_CREATE_FOR_HWND = Some(mem::transmute::<*mut c_void, CreateForHwndFn>(original)),
            Err(e) => log(&format!("diag: CreateSwapChainForHwnd hook failed: {e:?}")),
        }
        match MinHook::create_hook(factory.vtable().base__.base__.CreateSwapChain as *mut c_void, create_hk as *mut c_void) {
            Ok(original) => ORIGINAL_CREATE = Some(mem::transmute::<*mut c_void, CreateFn>(original)),
            Err(e) => log(&format!("diag: CreateSwapChain hook failed: {e:?}")),
        }
    }
}

fn os_build() -> String {
    // the same key the client's specs read
    let output = std::process::Command::new("cmd").args(["/C", "ver"]).output();
    output.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

fn describe_adapters(factory: &IDXGIFactory2) {
    unsafe {
        let Ok(factory1) = factory.cast::<IDXGIFactory1>() else { return };
        let mut index = 0;
        while let Ok(adapter) = factory1.EnumAdapters1(index) {
            index += 1;
            let Ok(desc) = adapter.GetDesc1() else { continue };
            let name = String::from_utf16_lossy(&desc.Description).trim_end_matches('\0').to_string();
            log(&format!(
                "diag: adapter {index}: {name} vendor {:#06x} device {:#06x} vram {} MB flags {:#x}",
                desc.VendorId,
                desc.DeviceId,
                desc.DedicatedVideoMemory / (1024 * 1024),
                desc.Flags
            ));
            // a device on this adapter: overlay support is asked per format and device, like Chromium does
            let mut device: Option<ID3D11Device> = None;
            let _ = D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_FLAG(0),
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            );
            let mut output_index = 0;
            while let Ok(output) = adapter.EnumOutputs(output_index) {
                output_index += 1;
                let Ok(out_desc) = output.GetDesc() else { continue };
                let rect = out_desc.DesktopCoordinates;
                // MPO: whether the display can show overlays in hardware, what Chromium's overlay promotion needs
                let mpo = output
                    .cast::<IDXGIOutput6>()
                    .ok()
                    .and_then(|output6| output6.CheckHardwareCompositionSupport().ok());
                // HDR changes which surfaces Chromium can use (a 10-bit root cannot be a DComp surface)
                let (color_space, bits) = output
                    .cast::<IDXGIOutput6>()
                    .ok()
                    .and_then(|output6| output6.GetDesc1().ok())
                    .map(|desc| (desc.ColorSpace.0, desc.BitsPerColor))
                    .unwrap_or((-1, 0));
                let overlays = match (&device, output.cast::<IDXGIOutput3>()) {
                    (Some(device), Ok(output3)) => [
                        ("NV12", DXGI_FORMAT_NV12),
                        ("YUY2", DXGI_FORMAT_YUY2),
                        ("BGRA", DXGI_FORMAT_B8G8R8A8_UNORM),
                        ("RGB10A2", DXGI_FORMAT_R10G10B10A2_UNORM),
                    ]
                    .iter()
                    .map(|(name, format)| format!("{name}={:#x}", output3.CheckOverlaySupport(*format, device).unwrap_or(0)))
                    .collect::<Vec<_>>()
                    .join(" "),
                    _ => "unknown".to_string(),
                };
                log(&format!(
                    "diag:   display {output_index}: {}x{} at {},{} attached {} hardware composition flags {:?} color space {} bits {} overlay support {}",
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    rect.left,
                    rect.top,
                    out_desc.AttachedToDesktop.as_bool(),
                    mpo,
                    color_space,
                    bits,
                    overlays
                ));
            }
        }
    }
}
