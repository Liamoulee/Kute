use minhook::MinHook;
use std::{ffi::c_void, mem, sync::atomic::Ordering};
use windows::Win32::{
    Foundation::*,
    Graphics::{
        Direct3D::*,
        Direct3D11::*,
        Dxgi::{Common::*, *},
    },
    System::{
        Memory::*,
        SystemServices::{DLL_PROCESS_ATTACH, DLL_PROCESS_DETACH},
        Threading::*,
    },
};
use windows::core::*;

#[macro_export]
macro_rules! debug_print {
    ($($arg:tt)*) => {
        if cfg!(feature = "verbose-logs") {
            let msg = format!($($arg)*);
            let wide: Vec<u16> = msg.encode_utf16().chain(Some(0)).collect();
            #[allow(unused_unsafe)]
            unsafe {
                ::windows::Win32::System::Diagnostics::Debug::OutputDebugStringW(
                    ::windows::core::PCWSTR(wide.as_ptr()),
                );
            }
        }
    };
}

mod capture;
#[macro_use]
mod shared;
mod present;
mod swapchain;

use present::*;
use shared::*;
use swapchain::*;

fn get_idxgi() -> Result<(IDXGIFactory2, IDXGISwapChain1)> {
    unsafe {
        // dummy factory + swap chain, only for the vtables
        let mut device: Option<ID3D11Device> = None;

        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_SINGLETHREADED,
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )?;

        let device = device.unwrap();

        let dxgi_device: IDXGIDevice = device.cast()?;
        let dxgi_adapter: IDXGIAdapter = dxgi_device.GetAdapter()?;
        let factory: IDXGIFactory2 = dxgi_adapter.GetParent()?;

        let swap_chain: IDXGISwapChain1 = factory.CreateSwapChainForComposition(
            &dxgi_device,
            &DXGI_SWAP_CHAIN_DESC1 {
                Width: 1,
                Height: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                Stereo: BOOL(0),
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
                BufferCount: 2,
                Scaling: DXGI_SCALING_STRETCH,
                SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
                AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
                Flags: 0,
            },
            None,
        )?;

        Ok((factory, swap_chain))
    }
}

fn attach() {
    debug_print!("render: attach started, pid={}", unsafe { GetCurrentProcessId() });
    unsafe {
        capture::capture_init();
        // bench runs (src/modules/bench.rs) use their own mapping
        let mapping_name = HSTRING::from(std::env::var("KUTE_TIMING_MAPPING").unwrap_or_else(|_| "KuteFrameTiming".to_string()));
        match OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, &mapping_name) {
            Ok(mapping) => {
                debug_print!("render: opened frame timing mapping={mapping:?}");
                let ptr = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, SHARED_STATE_SIZE);
                if !ptr.Value.is_null() {
                    SHARED_MEM_PTR.store(ptr.Value as u64, Ordering::Release);
                    debug_print!("render: mapped frame timing state={:?}", ptr.Value);
                } else {
                    debug_print!("render: MapViewOfFile for frame timing returned null");
                }
            }
            Err(_error) => (),
        }
        debug_print!("render: creating dummy D3D11 objects for hook discovery");
        let (factory, swap_chain) = get_idxgi().unwrap_or_else(|e| {
            debug_print!("Failed to get factory and swap chain: {:?}", e);
            panic!("Failed to get factory and swap chain");
        });

        let original_create_swapchain = MinHook::create_hook(
            factory.vtable().CreateSwapChainForComposition as *mut c_void,
            create_swapchain_hk as *mut c_void,
        )
        .unwrap_or_else(|e| {
            debug_print!("render: CreateSwapChainForComposition hook failed: {e:?}");
            panic!("CreateSwapChainForComposition hook failed")
        });
        debug_print!("render: swap-chain hook created, trampoline={original_create_swapchain:p}");

        let original_present = MinHook::create_hook(swap_chain.vtable().Present1 as *mut c_void, present_hk as *mut c_void).unwrap_or_else(|e| {
            debug_print!("render: Present1 hook failed: {e:?}");
            panic!("Present1 hook failed")
        });
        debug_print!("render: Present1 hook created, trampoline={original_present:p}");

        // store trampolines before enabling, a call in between would find None
        #[allow(clippy::missing_transmute_annotations)]
        {
            ORIGINAL_CREATE_SWAPCHAIN = mem::transmute(original_create_swapchain);
            ORIGINAL_PRESENT = mem::transmute(original_present);
        }
        match MinHook::enable_all_hooks() {
            Ok(()) => debug_print!("render: all MinHook hooks enabled"),
            Err(error) => debug_print!("render: cannot enable hooks: {error:?}"),
        }
        debug_print!("render: attach completed");
    }
}

// called by the gpu process right after LoadLibrary, before chromium makes a swap chain. 1 = ok
#[unsafe(no_mangle)]
pub extern "system" fn render_attach() -> i32 {
    match std::panic::catch_unwind(attach) {
        Ok(()) => 1,
        Err(_) => {
            debug_print!("render: attach panicked");
            0
        }
    }
}

// must return TRUE explicitly, a leftover zero in the register fails LoadLibrary
#[unsafe(no_mangle)]
extern "system" fn DllMain(_: HINSTANCE, call_reason: u32, reserved: *mut ()) -> BOOL {
    if call_reason == DLL_PROCESS_ATTACH {
        debug_print!("render: DLL_PROCESS_ATTACH, waiting for render_attach");
    } else if call_reason == DLL_PROCESS_DETACH && !reserved.is_null() {
        // process exit: other threads may be dead holding our locks, skip cleanup
        debug_print!("render: DLL_PROCESS_DETACH at process exit, nothing to clean up");
    } else if call_reason == DLL_PROCESS_DETACH {
        debug_print!("render: DLL_PROCESS_DETACH, cleaning capture state and handles");
        capture::capture_cleanup();
        unsafe {
            let mut guard = WAIT_HANDLE.write().unwrap();
            for (sc, handle) in guard.drain() {
                if !handle.0.is_invalid() {
                    debug_print!("render: closing handle {:?} for swapchain {:#x}", handle.0, sc);
                    let _ = CloseHandle(handle.0);
                }
            }
        }
    }
    TRUE
}
