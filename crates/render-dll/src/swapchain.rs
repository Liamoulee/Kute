use std::{
    collections::HashMap,
    ffi::c_void,
    mem,
    sync::{
        LazyLock, RwLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};
use windows::Win32::{
    Foundation::*,
    Graphics::{
        Direct3D11::*,
        Dxgi::{Common::*, *},
    },
};
use windows::core::*;

use crate::capture;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(transparent)]
pub(crate) struct SendHandle(pub HANDLE);

unsafe impl Send for SendHandle {}
unsafe impl Sync for SendHandle {}

#[allow(clippy::type_complexity)]
pub(crate) static mut ORIGINAL_CREATE_SWAPCHAIN: Option<
    unsafe fn(*mut c_void, *mut c_void, *const DXGI_SWAP_CHAIN_DESC1, *mut c_void, *mut *mut c_void) -> HRESULT,
> = None;

pub(crate) static WAIT_HANDLE: LazyLock<RwLock<HashMap<usize, SendHandle>>> = LazyLock::new(|| RwLock::new(HashMap::new()));
pub(crate) static WAIT_HANDLE_GENERATION: AtomicU64 = AtomicU64::new(0);

// the game's swap chain. chromium recreates it on resize, so it's decided at present time (is_main_swapchain)
static MAIN_SWAPCHAIN: AtomicUsize = AtomicUsize::new(0);
// last present of the game's chain, ms since PROCESS_START
pub(crate) static MAIN_LAST_PRESENT_MS: AtomicU64 = AtomicU64::new(0);
pub(crate) static PROCESS_START: LazyLock<std::time::Instant> = LazyLock::new(std::time::Instant::now);
// quiet this long and another big chain takes over
const MAIN_SILENT_MS: u64 = 300;

fn main_presented_within(ms: u64) -> bool {
    let now = PROCESS_START.elapsed().as_millis() as u64;
    now.saturating_sub(MAIN_LAST_PRESENT_MS.load(Ordering::Relaxed)) < ms
}

pub(crate) fn is_main_swapchain(swapchain: *mut c_void) -> bool {
    let this = swapchain as usize;
    let main = MAIN_SWAPCHAIN.load(Ordering::Relaxed);
    if main == this {
        return true;
    }
    if main != 0 && main_presented_within(MAIN_SILENT_MS) {
        return false;
    }
    debug_print!("render: swap chain {swapchain:?} is the game's now (was {main:#x})");
    MAIN_SWAPCHAIN.store(this, Ordering::Relaxed);
    true
}

pub(crate) static TEARING_SUPPORTED: AtomicBool = AtomicBool::new(false);

// same check as chromium's DXGISwapChainTearingSupported, cached
unsafe fn tearing_supported(factory: *mut c_void) -> bool {
    static CHECKED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let supported = *CHECKED.get_or_init(|| unsafe {
        let Some(factory) = IDXGIFactory2::from_raw_borrowed(&factory) else {
            return false;
        };
        let Ok(factory5) = factory.cast::<IDXGIFactory5>() else { return false };
        let mut allow = BOOL(0);
        let checked = factory5.CheckFeatureSupport(
            DXGI_FEATURE_PRESENT_ALLOW_TEARING,
            &mut allow as *mut BOOL as *mut c_void,
            mem::size_of::<BOOL>() as u32,
        );
        debug_print!("render: tearing supported={} ({checked:?})", allow.as_bool());
        checked.is_ok() && allow.as_bool()
    });
    TEARING_SUPPORTED.store(supported, Ordering::Relaxed);
    supported
}

unsafe fn create_swapchain_unmodified(
    this: *mut c_void,
    pdevice: *mut c_void,
    pdesc: *const DXGI_SWAP_CHAIN_DESC1,
    prestricttooutput: *mut c_void,
    ppswapchain: *mut *mut c_void,
) -> HRESULT {
    unsafe {
        let original_fn = ORIGINAL_CREATE_SWAPCHAIN.unwrap();
        let result = original_fn(this, pdevice, pdesc, prestricttooutput, ppswapchain);

        // a new chain can reuse a dead one's address, drop its stale wait handle
        if result.is_ok() && !ppswapchain.is_null() && WAIT_HANDLE.write().unwrap().remove(&(*ppswapchain as usize)).is_some() {
            debug_print!("render: purged stale wait handle for reused swapchain address {:?}", *ppswapchain);
            // invalidates present_hk's per-thread caches
            WAIT_HANDLE_GENERATION.fetch_add(1, Ordering::Release);
        }
        result
    }
}

pub(crate) unsafe extern "system" fn create_swapchain_hk(
    this: *mut c_void,
    pdevice: *mut c_void,
    pdesc: *const DXGI_SWAP_CHAIN_DESC1,
    prestricttooutput: *mut c_void,
    ppswapchain: *mut *mut c_void,
) -> HRESULT {
    unsafe {
        // skip chromium's tiny internal surfaces (16x16)
        if (*pdesc).Width < 200 || (*pdesc).Height < 200 {
            debug_print!("render: swap chain {}x{} left alone (under 200 px)", (*pdesc).Width, (*pdesc).Height);
            return create_swapchain_unmodified(this, pdevice, pdesc, prestricttooutput, ppswapchain);
        }
        debug_print!(
            "render: CreateSwapChainForComposition called original={}x{} buffers={} format={} flags={:#x}",
            (*pdesc).Width,
            (*pdesc).Height,
            (*pdesc).BufferCount,
            (*pdesc).Format.0,
            (*pdesc).Flags
        );
        let mut desc = *pdesc;
        // no SHADER_INPUT, it costs 25-50% of the uncapped present rate and nothing needs it
        desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        desc.BufferCount = 2;
        desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL; // discard crashes
        desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
        // DXGI_SCALING_NONE crashes
        desc.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT.0 as u32;
        if tearing_supported(this) {
            desc.Flags |= DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING.0 as u32;
        }

        let original_fn = ORIGINAL_CREATE_SWAPCHAIN.unwrap();

        let result = original_fn(this, pdevice, &desc, prestricttooutput, ppswapchain);
        if let Err(_e) = result.ok() {
            // fall back to chromium's own desc, panicking here kills the gpu process
            debug_print!("render: modified swap chain creation failed: {:#X} - {}, creating it unmodified", result.0, _e);
            create_swapchain_unmodified(this, pdevice, pdesc, prestricttooutput, ppswapchain)
        } else {
            debug_print!("render: swap chain created pointer={:?}", *ppswapchain);
            let swap_chain = IDXGISwapChain1::from_raw(*ppswapchain);
            // capture needs the real device
            let device = match swap_chain.GetDevice::<ID3D11Device>() {
                Ok(device) => {
                    debug_print!("render: acquired D3D11 device from swap chain");
                    Some(device)
                }
                Err(error) => {
                    debug_print!("render: failed to acquire swap-chain D3D11 device: {error}");
                    None
                }
            };
            capture::capture_on_swapchain(*ppswapchain, device);
            if let Ok(swap_chain2) = swap_chain.cast::<IDXGISwapChain2>() {
                swap_chain2
                    .SetMaximumFrameLatency(1)
                    .unwrap_or_else(|e| debug_print!("Failed to set latency: {:?}", e));
                // depth 1 is what the pacing relies on
                debug_print!("render: frame latency now {:?}", swap_chain2.GetMaximumFrameLatency());

                let waitable_obj = swap_chain2.GetFrameLatencyWaitableObject();
                debug_print!("render: frame-latency waitable object={waitable_obj:?}");
                {
                    let mut guard = WAIT_HANDLE.write().unwrap();
                    if let Some(old_handle) = guard.insert(*ppswapchain as usize, SendHandle(waitable_obj))
                        && !old_handle.0.is_invalid()
                    {
                        debug_print!("render: closing replaced swapchain wait handle={:?}", old_handle.0);
                        let _ = CloseHandle(old_handle.0);
                    }
                    WAIT_HANDLE_GENERATION.fetch_add(1, Ordering::Release);
                }

                // don't release
                mem::forget(swap_chain2);
            } else {
                debug_print!("render: swap chain does not expose IDXGISwapChain2");
            }
            result
        }
    }
}
