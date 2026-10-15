use minhook::MinHook;
use std::{
    ffi::c_void,
    mem,
    sync::atomic::{AtomicU64, Ordering},
};
use windows::Win32::{
    Foundation::*,
    Graphics::Dxgi::*,
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
mod wait;

use present::*;
use shared::*;
use swapchain::*;

// the Present1 hook goes on the first swap chain chromium creates, from inside the creation hook. the dummy D3D11
// device and 1x1 composition chain that used to give the vtable at attach time cost a tenth of a core and stalls of
// 50 to 140 ms for the whole life of the gpu process on a starved cpu (two e-cores: slowest frames 9 to 21 ms, worst
// 20 to 140 ms), hooks or no hooks, and that was the laptop problem
// where the Present1 hook stands. the first version set one flag before anything had succeeded, so a failed
// create or enable was final and invisible, with the chains still being modified for a hook that never ran
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HookStep {
    Uninstalled { attempts: u32 },
    Created { attempts: u32 },
    Enabled,
    Failed,
}

const HOOK_ATTEMPTS: u32 = 3;

impl HookStep {
    // what one try does to the step: a failed create or enable counts an attempt, the third one is final
    pub(crate) fn after(self, succeeded: bool) -> HookStep {
        match (self, succeeded) {
            (HookStep::Uninstalled { .. }, true) => HookStep::Created { attempts: 0 },
            (HookStep::Created { .. }, true) => HookStep::Enabled,
            (HookStep::Uninstalled { attempts }, false) if attempts + 1 < HOOK_ATTEMPTS => HookStep::Uninstalled { attempts: attempts + 1 },
            (HookStep::Created { attempts }, false) if attempts + 1 < HOOK_ATTEMPTS => HookStep::Created { attempts: attempts + 1 },
            (HookStep::Enabled, _) => HookStep::Enabled,
            _ => HookStep::Failed,
        }
    }

    // SharedState.hook_state low byte, the host shows it in get-specs
    pub(crate) fn code(self) -> u64 {
        match self {
            HookStep::Uninstalled { .. } | HookStep::Created { .. } => HOOK_WAITING,
            HookStep::Enabled => HOOK_READY,
            HookStep::Failed => HOOK_FAILED,
        }
    }
}

static PRESENT_HOOK: std::sync::Mutex<HookStep> = std::sync::Mutex::new(HookStep::Uninstalled { attempts: 0 });
// the Present1 address that got hooked: every chain of one DXGI implementation shares it, another one would mean a
// chain the hook does not see
static PRESENT_TARGET: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

static INSTALL_US: AtomicU64 = AtomicU64::new(0);
static MISMATCH_SEEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
// chains returned to chromium since attach, prepared for the hook and left as they were
static MODIFIED_CHAINS: AtomicU64 = AtomicU64::new(0);
static STOCK_CHAINS: AtomicU64 = AtomicU64::new(0);

pub(crate) fn present_hook_failed() -> bool {
    *PRESENT_HOOK.lock().unwrap() == HookStep::Failed
}

// the host decodes this in app.rs: low byte state, bit 4 mismatch, bits 8 to 31 install microseconds, bits 32 to 47
// modified chains, bits 48 and up stock chains
pub(crate) fn pack_hook_state(step: HookStep, mismatch: bool, install_us: u64, modified: u64, stock: u64) -> u64 {
    step.code() | if mismatch { HOOK_MISMATCH } else { 0 } | (install_us.min(0xFF_FFFF) << 8) | (modified.min(0xFFFF) << 32) | (stock.min(0xFFFF) << 48)
}

fn publish_hook_state(step: HookStep) {
    let ptr = SHARED_MEM_PTR.load(Ordering::Acquire);
    if ptr == 0 {
        return;
    }
    let value = pack_hook_state(
        step,
        MISMATCH_SEEN.load(Ordering::Relaxed),
        INSTALL_US.load(Ordering::Relaxed),
        MODIFIED_CHAINS.load(Ordering::Relaxed),
        STOCK_CHAINS.load(Ordering::Relaxed),
    );
    unsafe { shared!(ptr, hook_state).store(value, Ordering::Release) };
}

// counts a chain handed to chromium, so a bench result can show whether chains got prepared while the hook was down
pub(crate) fn note_chain(modified: bool) {
    if modified { &MODIFIED_CHAINS } else { &STOCK_CHAINS }.fetch_add(1, Ordering::Relaxed);
    publish_hook_state(*PRESENT_HOOK.lock().unwrap());
}

// bench knob: KUTE_HOOK_FAIL=create:N or enable:N makes the first N tries of that step fail
fn injected_failure(step: &str) -> bool {
    static LEFT: std::sync::Mutex<Option<(String, u32)>> = std::sync::Mutex::new(None);
    if !crate::swapchain::knobs_allowed() {
        return false;
    }
    let mut left = LEFT.lock().unwrap();
    if left.is_none() {
        let spec = std::env::var("KUTE_HOOK_FAIL").unwrap_or_default();
        let (which, count) = spec.split_once(':').unwrap_or(("", "0"));
        *left = Some((which.to_string(), count.parse().unwrap_or(0)));
    }
    match left.as_mut() {
        Some((which, count)) if which == step && *count > 0 => {
            *count -= 1;
            true
        }
        _ => false,
    }
}

// installs the Present1 hook from this chain's vtable, once, with the step and its outcome published to the host.
// called for every chain chromium creates: later ones only check that their Present1 is the hooked one. returns
// whether this chain's presents reach the hook, the caller leaves a chain that they do not as chromium made it
pub(crate) unsafe fn hook_present_of(swap_chain: *mut c_void) -> bool {
    let started = std::time::Instant::now();
    let mut step = PRESENT_HOOK.lock().unwrap();
    let target = unsafe { IDXGISwapChain1::from_raw_borrowed(&swap_chain).unwrap().vtable().Present1 as *mut c_void };
    let hooked = PRESENT_TARGET.load(Ordering::Acquire);
    if hooked != 0 && hooked != target as usize {
        debug_print!("render: a swap chain with another Present1 ({target:p}, hooked {hooked:#x}), its presents are not seen");
        MISMATCH_SEEN.store(true, Ordering::Relaxed);
        publish_hook_state(*step);
        return false;
    }
    if matches!(*step, HookStep::Enabled | HookStep::Failed) {
        return *step == HookStep::Enabled;
    }
    // a failed allocation or page protection is tried again at once, the third failure of a step is final. minhook
    // skips a thread it cannot suspend without an error, that case never gets here
    while !matches!(*step, HookStep::Enabled | HookStep::Failed) {
        if let HookStep::Uninstalled { .. } = *step {
            let created = if injected_failure("create") {
                Err(minhook::MH_STATUS::MH_ERROR_MEMORY_ALLOC)
            } else {
                unsafe { MinHook::create_hook(target, present_hk as *mut c_void) }
            };
            match created {
                Ok(trampoline) => {
                    // stored before enabling, a present in between would find None
                    #[allow(clippy::missing_transmute_annotations)]
                    unsafe {
                        ORIGINAL_PRESENT = mem::transmute(trampoline);
                    }
                    PRESENT_TARGET.store(target as usize, Ordering::Release);
                    *step = step.after(true);
                }
                Err(_e) => {
                    debug_print!("render: Present1 hook not created: {_e:?}");
                    *step = step.after(false);
                }
            }
        }
        if let HookStep::Created { .. } = *step {
            let enabled = if injected_failure("enable") {
                Err(minhook::MH_STATUS::MH_ERROR_MEMORY_PROTECT)
            } else {
                unsafe { MinHook::enable_hook(target) }
            };
            match enabled {
                Ok(()) => *step = step.after(true),
                Err(_e) => {
                    debug_print!("render: Present1 hook not enabled: {_e:?}");
                    *step = step.after(false);
                }
            }
        }
    }
    let install_us = started.elapsed().as_micros() as u64;
    debug_print!("render: Present1 hook {:?} after {install_us} us", *step);
    INSTALL_US.store(install_us, Ordering::Relaxed);
    publish_hook_state(*step);
    *step == HookStep::Enabled
}

fn attach() {
    debug_print!("render: attach started, pid={}", unsafe { GetCurrentProcessId() });
    // KUTE_HOOK_DETACH=1: bench knob, the dll is loaded and nothing else happens
    if crate::swapchain::knob("KUTE_HOOK_DETACH", 0) == 1 {
        return;
    }
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
                    // a restarted gpu process must not inherit the last one's "ready"
                    shared!(ptr.Value as u64, hook_state).store(HOOK_WAITING, Ordering::Release);
                    debug_print!("render: mapped frame timing state={:?}", ptr.Value);
                } else {
                    debug_print!("render: MapViewOfFile for frame timing returned null");
                }
            }
            Err(_error) => (),
        }
        // a factory without a device gives the creation vtable, chromium's device never sees a second one
        let factory: IDXGIFactory2 = CreateDXGIFactory1().unwrap_or_else(|e| {
            debug_print!("render: CreateDXGIFactory1 failed: {e:?}");
            panic!("CreateDXGIFactory1 failed")
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
        // stored before enabling, a call in between would find None
        #[allow(clippy::missing_transmute_annotations)]
        {
            ORIGINAL_CREATE_SWAPCHAIN = mem::transmute(original_create_swapchain);
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

#[cfg(test)]
mod hook_step_tests {
    use super::HookStep;

    #[test]
    fn a_failed_create_or_enable_gets_two_more_tries() {
        let start = HookStep::Uninstalled { attempts: 0 };
        let once = start.after(false);
        assert_eq!(once, HookStep::Uninstalled { attempts: 1 });
        assert_eq!(once.after(false).after(false), HookStep::Failed);
        let created = once.after(true);
        assert_eq!(created, HookStep::Created { attempts: 0 });
        assert_eq!(created.after(false), HookStep::Created { attempts: 1 });
        assert_eq!(created.after(false).after(true), HookStep::Enabled);
        assert_eq!(created.after(false).after(false).after(false), HookStep::Failed);
    }

    #[test]
    fn the_state_word_keeps_every_field() {
        let word = super::pack_hook_state(HookStep::Enabled, true, 34_015, 3, 7);
        assert_eq!(word & 0xF, super::HOOK_READY);
        assert_eq!(word & super::HOOK_MISMATCH, super::HOOK_MISMATCH);
        assert_eq!((word >> 8) & 0xFF_FFFF, 34_015);
        assert_eq!((word >> 32) & 0xFFFF, 3);
        assert_eq!(word >> 48, 7);
        // saturates instead of spilling into the next field
        let big = super::pack_hook_state(HookStep::Failed, false, u64::MAX, u64::MAX, u64::MAX);
        assert_eq!(big & 0xF, super::HOOK_FAILED);
        assert_eq!((big >> 8) & 0xFF_FFFF, 0xFF_FFFF);
        assert_eq!((big >> 32) & 0xFFFF, 0xFFFF);
    }

    #[test]
    fn enabled_and_failed_are_final() {
        assert_eq!(HookStep::Enabled.after(false), HookStep::Enabled);
        assert_eq!(HookStep::Failed.after(true), HookStep::Failed);
        assert_eq!(HookStep::Uninstalled { attempts: 2 }.code(), super::HOOK_WAITING);
        assert_eq!(HookStep::Enabled.code(), super::HOOK_READY);
        assert_eq!(HookStep::Failed.code(), super::HOOK_FAILED);
    }
}
