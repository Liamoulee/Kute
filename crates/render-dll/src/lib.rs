use minhook::MinHook;
use std::{
    cell,
    collections::HashMap,
    ffi::c_void,
    mem,
    sync::{
        LazyLock, RwLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    thread,
};
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

mod capture;

// Thread-safe wrapper for Win32 kernel handles
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(transparent)]
struct SendHandle(pub HANDLE);

unsafe impl Send for SendHandle {}
unsafe impl Sync for SendHandle {}

// layout must match SharedStats in src/app.rs
#[repr(C)]
struct SharedState {
    frame_ns: u64,
    fps: u64,
    target_fps: u64,
    // the host bumps stats_request, the hook answers with the distribution of the intervals it collected since
    // the last request and sets stats_ack to the same number. this is what frame pacing is judged by: an average
    // cannot tell an even 240 from bursts and stalls that add up to 240
    stats_request: u64,
    stats_ack: u64,
    // intervals between the calls into the real Present1, after the limiter: what goes out to the screen
    present_p50_ns: u64,
    present_p99_ns: u64,
    present_max_ns: u64,
    // intervals between chromium handing frames to the hook, before any waiting: what the pipeline delivers
    arrive_p99_ns: u64,
    samples: u64,
}
const SHARED_STATE_SIZE: usize = std::mem::size_of::<SharedState>();

// one field of the mapping as an atomic. The protocol and why every access is atomic: `shared!` in the host's
// app.rs. `ptr` is the view from SHARED_MEM_PTR, page aligned, every field a u64 at a multiple of 8. Used inside
// the hook's unsafe blocks, which is where from_ptr's requirements are met
macro_rules! shared {
    ($ptr:expr, $field:ident) => {
        AtomicU64::from_ptr(($ptr as usize + std::mem::offset_of!(SharedState, $field)) as *mut u64)
    };
}

const INTERVAL_SAMPLES: usize = 16384;

// waiting on the swap chain's frame latency object: the regular timeout, how many timeouts in a row pause the
// waiting, for how long, and the shorter timeout of the single wait that probes afterwards (long enough for a
// GPU bound game at 20 FPS, short enough to cost nothing while nobody looks at the window)
const WAIT_TIMEOUT_MS: u32 = 100;
const WAIT_TIMEOUTS_BEFORE_PAUSE: u32 = 3;
const WAIT_PAUSE: std::time::Duration = std::time::Duration::from_secs(2);
const WAIT_PROBE_MS: u32 = 50;
// a gap this long between two presents is a pause (window hidden, a load), not a frame time
const PAUSE_NS: u64 = 250_000_000;

struct Intervals {
    ns: Vec<u32>,
    next: usize,
    count: usize,
    last: Option<std::time::Instant>,
}

impl Intervals {
    fn new() -> Self {
        Intervals {
            ns: vec![0; INTERVAL_SAMPLES],
            next: 0,
            count: 0,
            last: None,
        }
    }

    fn mark(&mut self, now: std::time::Instant) {
        if let Some(last) = self.last {
            self.ns[self.next] = now.duration_since(last).as_nanos().min(u32::MAX as u128) as u32;
            self.next = (self.next + 1) % INTERVAL_SAMPLES;
            self.count = (self.count + 1).min(INTERVAL_SAMPLES);
        }
        self.last = Some(now);
    }

    // (p50, p99, max), and starts a fresh window
    fn take(&mut self) -> (u64, u64, u64, u64) {
        let mut sorted: Vec<u32> = self.ns[..self.count].to_vec();
        sorted.sort_unstable();
        let at = |p: f64| {
            sorted
                .get(((sorted.len() as f64 * p) as usize).min(sorted.len().saturating_sub(1)))
                .copied()
                .unwrap_or(0) as u64
        };
        let result = (at(0.5), at(0.99), sorted.last().copied().unwrap_or(0) as u64, sorted.len() as u64);
        self.next = 0;
        self.count = 0;
        result
    }
}

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

fn get_idxgi() -> Result<(IDXGIFactory2, IDXGISwapChain1)> {
    unsafe {
        // make a dummy factory and dummy swap chain for the vtable
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

#[allow(clippy::type_complexity)]
static mut ORIGINAL_CREATE_SWAPCHAIN: Option<unsafe fn(*mut c_void, *mut c_void, *const DXGI_SWAP_CHAIN_DESC1, *mut c_void, *mut *mut c_void) -> HRESULT> =
    None;

#[allow(clippy::type_complexity)]
static mut ORIGINAL_PRESENT: Option<unsafe fn(*mut c_void, u32, DXGI_PRESENT, *const DXGI_PRESENT_PARAMETERS) -> HRESULT> = None;

static WAIT_HANDLE: LazyLock<RwLock<HashMap<usize, SendHandle>>> = LazyLock::new(|| RwLock::new(HashMap::new()));
static WAIT_HANDLE_GENERATION: AtomicU64 = AtomicU64::new(0);

static SHARED_MEM_PTR: AtomicU64 = AtomicU64::new(0);
static MISSING_TIMING_MAPPING_LOGGED: AtomicBool = AtomicBool::new(false);

static GLOBAL_LIMIT_CLOCK: LazyLock<RwLock<Option<std::time::Instant>>> = LazyLock::new(|| RwLock::new(None));
// Which swap chain is the game's. chromium does not keep one: it makes a new one whenever the window changes
// size and whenever it comes back from being minimized or hidden (then even two in a row), and "the first big
// one, once" left all of those untouched, so after a single minimize or resize the stats, the FPS limiter and
// the OBS capture were gone until a restart. So every big swap chain gets prepared when it is created, and
// which one is the game's gets decided where the truth is, at present time: the one that holds the title keeps
// it as long as it presents, and when it has gone quiet the next big chain that presents takes over. A game
// that is shown presents every few milliseconds, so a popup (social) next to a running game never takes over.
static MAIN_SWAPCHAIN: AtomicUsize = AtomicUsize::new(0);
// when the game's swap chain last presented, in ms since PROCESS_START. one store per frame
static MAIN_LAST_PRESENT_MS: AtomicU64 = AtomicU64::new(0);
static PROCESS_START: LazyLock<std::time::Instant> = LazyLock::new(std::time::Instant::now);
// this long without a present and the title is up for grabs. long enough that a hitch of the game does not hand
// it to a popup, short enough that the game runs without its limiter for a moment only after a resize
const MAIN_SILENT_MS: u64 = 300;

fn main_presented_within(ms: u64) -> bool {
    let now = PROCESS_START.elapsed().as_millis() as u64;
    now.saturating_sub(MAIN_LAST_PRESENT_MS.load(Ordering::Relaxed)) < ms
}

// whether this (prepared) swap chain is the game's, taking the title when the holder has gone quiet
fn is_main_swapchain(swapchain: *mut c_void) -> bool {
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

fn attach() {
    debug_print!("render: attach started, pid={}", unsafe { GetCurrentProcessId() });
    unsafe {
        capture::capture_init();
        // a bench run (src/modules/bench.rs) points its gpu process at its own mapping
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

        // the trampolines first: a hooked call arriving between enabling and storing would find None
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

// set once the first big swap chain gets created, read by every present of ours
static TEARING_SUPPORTED: AtomicBool = AtomicBool::new(false);

// the check chromium makes before it asks for tearing (DXGISwapChainTearingSupported). asked once
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

// chromium's swap chain as it asked for it
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

        // new swapchain creation can be on the same address as a destroyed one, so purge stale wait handle
        if result.is_ok() && !ppswapchain.is_null() && WAIT_HANDLE.write().unwrap().remove(&(*ppswapchain as usize)).is_some() {
            debug_print!("render: purged stale wait handle for reused swapchain address {:?}", *ppswapchain);
            // bump when WAIT_HANDLE changes so the per-thread caches in present_hk drop stale entries
            WAIT_HANDLE_GENERATION.fetch_add(1, Ordering::Release);
        }
        result
    }
}

unsafe extern "system" fn create_swapchain_hk(
    this: *mut c_void,
    pdevice: *mut c_void,
    pdesc: *const DXGI_SWAP_CHAIN_DESC1,
    prestricttooutput: *mut c_void,
    ppswapchain: *mut *mut c_void,
) -> HRESULT {
    unsafe {
        // small ones are chromium's own little surfaces (the only one seen is 16x16), every other one is a window's,
        // see MAIN_SWAPCHAIN. 200 and not 600 px: a game window under 600 physical px tall used to run without the hook
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
        // only RENDER_TARGET_OUTPUT, on purpose: keeping chromium's SHADER_INPUT bit ("needed to bind to GL texture")
        // cut the uncapped present rate by a quarter to a half in interleaved runs, and nothing needs it
        desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        desc.BufferCount = 2; // 2 is the minimum
        desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL; // discard crashes
        desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
        // desc.Scaling = DXGI_SCALING_NONE; // this crashes
        desc.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT.0 as u32;
        // like chromium itself: tearing only where the system supports it
        if tearing_supported(this) {
            desc.Flags |= DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING.0 as u32;
        }

        let original_fn = ORIGINAL_CREATE_SWAPCHAIN.unwrap();

        let result = original_fn(this, pdevice, &desc, prestricttooutput, ppswapchain);
        if let Err(_e) = result.ok() {
            // a panic here took the whole GPU process down. chromium's own swap chain is the better outcome, it only
            // goes without the limiter, stats and capture (and chromium handles a failure of that one by itself)
            debug_print!("render: modified swap chain creation failed: {:#X} - {}, creating it unmodified", result.0, _e);
            create_swapchain_unmodified(this, pdevice, pdesc, prestricttooutput, ppswapchain)
        } else {
            debug_print!("render: swap chain created pointer={:?}", *ppswapchain);
            let swap_chain = IDXGISwapChain1::from_raw(*ppswapchain);
            // Learn the real D3D11 device from this swap chain and hand it to the capture module
            // (it invalidates any shared texture so it is re-created against this swap chain).
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
                // what holds in the end: depth 1 is what the pacing rests on
                debug_print!("render: frame latency now {:?}", swap_chain2.GetMaximumFrameLatency());

                let waitable_obj = swap_chain2.GetFrameLatencyWaitableObject();
                debug_print!("render: frame-latency waitable object={waitable_obj:?}");
                {
                    let mut guard = WAIT_HANDLE.write().unwrap();
                    // a new swap chain can land on the address of a destroyed one, whose handle is stale then
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

#[link(name = "Avrt")]
unsafe extern "system" {
    fn AvSetMmThreadCharacteristicsW(task_name: PCWSTR, task_index: *mut u32) -> HANDLE;
}

unsafe extern "system" fn present_hk(
    p_this: *mut c_void,
    sync_interval: u32,
    mut present_flags: DXGI_PRESENT,
    p_present_parameters: *const DXGI_PRESENT_PARAMETERS,
) -> HRESULT {
    let ptr = SHARED_MEM_PTR.load(Ordering::Acquire);
    if ptr == 0 {
        if !MISSING_TIMING_MAPPING_LOGGED.swap(true, Ordering::Relaxed) {
            debug_print!("render: Present1 running without KuteFrameTiming mapping; timing, limiter, and capture path bypassed");
        }
        unsafe {
            let original_present = ORIGINAL_PRESENT.unwrap();
            return original_present(p_this, sync_interval, present_flags, p_present_parameters);
        }
    }

    thread_local! {
        static INITIALIZED: cell::Cell<bool> = const { cell::Cell::new(false) };
        static LAST_PRESENT: cell::Cell<Option<std::time::Instant>> = const { cell::Cell::new(None) };
        static FRAME_NS_EMA: cell::Cell<u64> = const { cell::Cell::new(0) };
        static ARRIVALS: std::cell::RefCell<Intervals> = std::cell::RefCell::new(Intervals::new());
        static PRESENTS: std::cell::RefCell<Intervals> = std::cell::RefCell::new(Intervals::new());
        static LAST_REPORTED_MOVE_QPC: cell::Cell<i64> = const { cell::Cell::new(0) };
        static DIAGNOSTIC_START: cell::Cell<Option<std::time::Instant>> = const { cell::Cell::new(None) };
        static DIAGNOSTIC_PRESENTS: cell::Cell<u64> = const { cell::Cell::new(0) };
        static DIAGNOSTIC_MAX_FRAME_NS: cell::Cell<u64> = const { cell::Cell::new(0) };

        static CACHED_WAIT_HANDLES: std::cell::RefCell<HashMap<usize, SendHandle>> = std::cell::RefCell::new(HashMap::new());
        static CACHED_WAIT_GENERATION: cell::Cell<u64> = const { cell::Cell::new(0) };
        static WAIT_TIMEOUT_STREAK: cell::Cell<u32> = const { cell::Cell::new(0) };
        static WAIT_PAUSED_UNTIL: cell::Cell<Option<std::time::Instant>> = const { cell::Cell::new(None) };

        // per-thread perf accounting for wall-clock time matching help me debug, but can be removed
        static PERF_WINDOW_START: cell::Cell<Option<std::time::Instant>> = const { cell::Cell::new(None) };
        static PERF_PRESENTS: cell::Cell<u64> = const { cell::Cell::new(0) };
        static PERF_WAIT_NS: cell::Cell<u64> = const { cell::Cell::new(0) };
        static PERF_WAIT_MAX_NS: cell::Cell<u64> = const { cell::Cell::new(0) };
        static PERF_PRESENT_NS: cell::Cell<u64> = const { cell::Cell::new(0) };
        static PERF_PRESENT_MAX_NS: cell::Cell<u64> = const { cell::Cell::new(0) };
        static PERF_TIMEOUTS: cell::Cell<u64> = const { cell::Cell::new(0) };
    }
    if !INITIALIZED.get() {
        let mut task_index = 0u32;
        let avrt_handle = unsafe { AvSetMmThreadCharacteristicsW(w!("Games"), &mut task_index) };
        debug_print!(
            "render: present thread initialized id={} avrt_handle={avrt_handle:?} task_index={task_index}",
            unsafe { GetCurrentThreadId() }
        );
        INITIALIZED.set(true);
    }

    unsafe {
        let generation = WAIT_HANDLE_GENERATION.load(Ordering::Acquire);
        let handle_opt = CACHED_WAIT_HANDLES.with(|cache| {
            let mut map = cache.borrow_mut();
            if CACHED_WAIT_GENERATION.get() != generation {
                map.clear();
                CACHED_WAIT_GENERATION.set(generation);
            }
            if let Some(&h) = map.get(&(p_this as usize)) {
                Some(h)
            } else {
                let h = WAIT_HANDLE.read().unwrap().get(&(p_this as usize)).copied();
                if let Some(h) = h {
                    map.insert(p_this as usize, h);
                }
                h
            }
        });

        let is_main = handle_opt.is_some() && is_main_swapchain(p_this);

        // track main swapchain only so the EMA and Present FPS aren't polluted
        if is_main {
            LAST_PRESENT.with(|last| {
                let now = std::time::Instant::now();
                MAIN_LAST_PRESENT_MS.store(now.duration_since(*PROCESS_START).as_millis() as u64, Ordering::Relaxed);
                ARRIVALS.with_borrow_mut(|arrivals| arrivals.mark(now));
                if let Some(prev) = last.get() {
                    let frame_ns = now.duration_since(prev).as_nanos() as u64;
                    if cfg!(feature = "verbose-logs") {
                        DIAGNOSTIC_MAX_FRAME_NS.set(DIAGNOSTIC_MAX_FRAME_NS.get().max(frame_ns));
                    }
                    FRAME_NS_EMA.with(|avg| {
                        // a pause is not a frame time: averaged in, one 16 s gap reads as "2 FPS" and takes a
                        // hundred frames to fade (an auto-detect run once capped a PC at 5 FPS because of it).
                        // the average starts over with the next frame instead
                        if frame_ns > PAUSE_NS {
                            avg.set(0);
                            return;
                        }
                        let next = if avg.get() == 0 { frame_ns } else { (avg.get() * 31 + frame_ns) / 32 };
                        avg.set(next);
                        // back-to-back presents can land within timer resolution so keep the div safe
                        let fps = 1_000_000_000u64.checked_div(next).unwrap_or(0);

                        shared!(ptr, frame_ns).store(next, Ordering::Relaxed);
                        shared!(ptr, fps).store(fps, Ordering::Relaxed);
                    });
                }

                last.set(Some(now));
                if cfg!(feature = "verbose-logs") {
                    DIAGNOSTIC_PRESENTS.set(DIAGNOSTIC_PRESENTS.get().wrapping_add(1));
                    let diagnostic_start = DIAGNOSTIC_START.get().unwrap_or_else(|| {
                        DIAGNOSTIC_START.set(Some(now));
                        now
                    });
                    if now.duration_since(diagnostic_start) >= std::time::Duration::from_secs(10) {
                        let ema_ns = FRAME_NS_EMA.get();
                        let ema_fps = 1_000_000_000u64.checked_div(ema_ns).unwrap_or(0);
                        let target_fps = shared!(ptr, target_fps).load(Ordering::Relaxed);
                        let has_wait_handle = WAIT_HANDLE.read().unwrap().contains_key(&(p_this as usize));
                        debug_print!(
                            "render: 10s stats thread_id={} presents={} ema_fps={} ema_ms={:.3} max_frame_ms={:.3} target_fps={} wait_handle={}",
                            GetCurrentThreadId(),
                            DIAGNOSTIC_PRESENTS.get(),
                            ema_fps,
                            ema_ns as f64 / 1_000_000.0,
                            DIAGNOSTIC_MAX_FRAME_NS.get() as f64 / 1_000_000.0,
                            target_fps,
                            has_wait_handle
                        );
                        DIAGNOSTIC_START.set(Some(now));
                        DIAGNOSTIC_PRESENTS.set(0);
                        DIAGNOSTIC_MAX_FRAME_NS.set(0);
                    }
                }
            });
        }

        let wait_started = std::time::Instant::now();
        if let Some(h) = handle_opt {
            // a window that is not being shown (minimized, hidden, covered) never signals its wait object, and
            // every present would sit out the full timeout. so after a few timeouts in a row the waiting gets
            // paused, NOT the handle dropped: having a handle is what makes this the game's swap chain, and
            // dropping it used to switch off the stats and the FPS limiter for the rest of the session, after
            // nothing more than one minimize. after the pause a single shorter wait probes whether the window
            // is back, and the pacing resumes by itself
            let paused_until = WAIT_PAUSED_UNTIL.get();
            let probing = paused_until.is_some();
            if paused_until.is_none_or(|until| wait_started >= until) {
                let wait_result = WaitForSingleObjectEx(h.0, if probing { WAIT_PROBE_MS } else { WAIT_TIMEOUT_MS }, false);
                if wait_result == WAIT_FAILED {
                    // the handle itself is broken, waiting on it will never work again
                    debug_print!("render: dropping broken wait handle for swapchain {p_this:?}");
                    WAIT_TIMEOUT_STREAK.set(0);
                    WAIT_PAUSED_UNTIL.set(None);
                    WAIT_HANDLE.write().unwrap().remove(&(p_this as usize));
                    WAIT_HANDLE_GENERATION.fetch_add(1, Ordering::Release);
                } else if wait_result == WAIT_TIMEOUT {
                    if cfg!(feature = "verbose-logs") {
                        PERF_TIMEOUTS.set(PERF_TIMEOUTS.get() + 1);
                    }
                    let streak = WAIT_TIMEOUT_STREAK.get() + 1;
                    WAIT_TIMEOUT_STREAK.set(streak);
                    if probing || streak >= WAIT_TIMEOUTS_BEFORE_PAUSE {
                        if !probing {
                            debug_print!("render: wait object of swapchain {p_this:?} is not signaling, pausing the wait");
                        }
                        WAIT_TIMEOUT_STREAK.set(0);
                        WAIT_PAUSED_UNTIL.set(Some(wait_started + WAIT_PAUSE));
                    }
                } else {
                    if probing {
                        debug_print!("render: wait object of swapchain {p_this:?} signals again, waiting resumed");
                    }
                    WAIT_TIMEOUT_STREAK.set(0);
                    WAIT_PAUSED_UNTIL.set(None);
                }
            }
        }
        let wait_ns = if cfg!(feature = "verbose-logs") {
            wait_started.elapsed().as_nanos() as u64
        } else {
            0
        };

        // if the DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING swapchain was created with ALLOW_TEARING, we can present with it.
        // otheriwse it would fail with DXGI_ERROR_INVALID_CALL
        if sync_interval == 0 && handle_opt.is_some() && TEARING_SUPPORTED.load(Ordering::Relaxed) {
            present_flags |= DXGI_PRESENT_ALLOW_TEARING;
        }
        let present_started = std::time::Instant::now();
        if is_main {
            PRESENTS.with_borrow_mut(|presents| presents.mark(present_started));
        }
        let original_present = ORIGINAL_PRESENT.unwrap();
        let mut hr = original_present(p_this, sync_interval, present_flags, p_present_parameters);
        if hr.is_err() && (present_flags.0 & DXGI_PRESENT_ALLOW_TEARING.0) != 0 {
            debug_print!("Present failed with tearing flag: {:#X}, retrying fallback", hr.0);
            let fallback_flags = DXGI_PRESENT(present_flags.0 & !DXGI_PRESENT_ALLOW_TEARING.0);
            hr = original_present(p_this, sync_interval, fallback_flags, p_present_parameters);
            debug_print!("render: Present fallback result={:#X}", hr.0);
        }

        if is_main {
            capture::capture_on_present(p_this);
            // a request for the interval distribution is answered after the real present: sorting up to
            // INTERVAL_SAMPLES values must not hold back the frame that is going out
            let request = shared!(ptr, stats_request).load(Ordering::Acquire);
            if request != shared!(ptr, stats_ack).load(Ordering::Relaxed) {
                let (p50, p99, max, samples) = PRESENTS.with_borrow_mut(|presents| presents.take());
                let (_, arrive_p99, _, _) = ARRIVALS.with_borrow_mut(|arrivals| arrivals.take());
                shared!(ptr, present_p50_ns).store(p50, Ordering::Relaxed);
                shared!(ptr, present_p99_ns).store(p99, Ordering::Relaxed);
                shared!(ptr, present_max_ns).store(max, Ordering::Relaxed);
                shared!(ptr, arrive_p99_ns).store(arrive_p99, Ordering::Relaxed);
                shared!(ptr, samples).store(samples, Ordering::Relaxed);
                // the host reads the payload once it sees this ack (Acquire), so it comes last
                shared!(ptr, stats_ack).store(request, Ordering::Release);
            }
        }

        // how long the real present took, without the limiter's sleep below
        let present_ns = if cfg!(feature = "verbose-logs") {
            present_started.elapsed().as_nanos() as u64
        } else {
            0
        };

        // limiter (main swapchain only), AFTER the real present. the renderer can start its next frame while this
        // thread sleeps (the swap ack does not wait for Present1 to return), so with the sleep before the present a
        // frame had its input read and then sat out the whole sleep: at a cap of 144 the input was 13 ms old when the
        // frame went out. now the frame goes out as soon as it arrives, about 1 ms after the game read its input at
        // the median (Chromium trace from the rAF callbacks to Present1, caps 144 and 240, same frame pacing)
        let target_fps = shared!(ptr, target_fps).load(Ordering::Relaxed);
        if is_main && let Some(nanos) = 1_000_000_000u64.checked_div(target_fps) {
            let target_frame_time = std::time::Duration::from_nanos(nanos);
            let now = std::time::Instant::now();
            let prev_opt = { *GLOBAL_LIMIT_CLOCK.read().unwrap() };

            let deadline = match prev_opt {
                Some(prev) => prev + target_frame_time,
                None => now,
            };
            if now < deadline {
                let remaining = deadline - now;
                debug_print!(
                    "render: limiter active on thread_id={} sleeping {:.2}ms to maintain target_fps={}",
                    GetCurrentThreadId(),
                    remaining.as_secs_f64() * 1000.0,
                    target_fps
                );
                // spin the last ~1ms for accuracy
                if remaining > std::time::Duration::from_millis(2) {
                    thread::sleep(remaining - std::time::Duration::from_millis(1));
                }
                while std::time::Instant::now() < deadline {
                    std::hint::spin_loop();
                }
            }

            // make sure sleep doesn't overshoot by scheduling next frame from deadline and not wakeup
            let after = std::time::Instant::now();
            let next_ref = if after.duration_since(deadline) > target_frame_time {
                after
            } else {
                deadline
            };
            *GLOBAL_LIMIT_CLOCK.write().unwrap() = Some(next_ref);
        }
        // end of limiter

        if cfg!(feature = "verbose-logs") {
            // report stalls (maybe it helps some other dev one day)
            if wait_ns > 50_000_000 || present_ns > 50_000_000 {
                debug_print!(
                    "render: STALL thread={} swapchain={:?} wait_ms={:.1} present_ms={:.1} hr={:#X} had_handle={}",
                    GetCurrentThreadId(),
                    p_this,
                    wait_ns as f64 / 1_000_000.0,
                    present_ns as f64 / 1_000_000.0,
                    hr.0,
                    handle_opt.is_some()
                );
            }
            PERF_PRESENTS.set(PERF_PRESENTS.get() + 1);
            PERF_WAIT_NS.set(PERF_WAIT_NS.get() + wait_ns);
            PERF_WAIT_MAX_NS.set(PERF_WAIT_MAX_NS.get().max(wait_ns));
            PERF_PRESENT_NS.set(PERF_PRESENT_NS.get() + present_ns);
            PERF_PRESENT_MAX_NS.set(PERF_PRESENT_MAX_NS.get().max(present_ns));
            let window_start = PERF_WINDOW_START.get().unwrap_or_else(|| {
                let now = std::time::Instant::now();
                PERF_WINDOW_START.set(Some(now));
                now
            });
            if window_start.elapsed() >= std::time::Duration::from_secs(5) {
                let n = PERF_PRESENTS.get().max(1);
                debug_print!(
                    "render: perf thread={} swapchain={:?} presents={} fps={:.0} wait_avg_ms={:.2} wait_max_ms={:.1} present_avg_ms={:.2} present_max_ms={:.1} timeouts={} had_handle={}",
                    GetCurrentThreadId(),
                    p_this,
                    n,
                    n as f64 / window_start.elapsed().as_secs_f64(),
                    PERF_WAIT_NS.get() as f64 / n as f64 / 1_000_000.0,
                    PERF_WAIT_MAX_NS.get() as f64 / 1_000_000.0,
                    PERF_PRESENT_NS.get() as f64 / n as f64 / 1_000_000.0,
                    PERF_PRESENT_MAX_NS.get() as f64 / 1_000_000.0,
                    PERF_TIMEOUTS.get(),
                    handle_opt.is_some()
                );
                PERF_WINDOW_START.set(Some(std::time::Instant::now()));
                PERF_PRESENTS.set(0);
                PERF_WAIT_NS.set(0);
                PERF_WAIT_MAX_NS.set(0);
                PERF_PRESENT_NS.set(0);
                PERF_PRESENT_MAX_NS.set(0);
                PERF_TIMEOUTS.set(0);
            }
        }

        hr
    }
}

// called by the gpu subprocess right after LoadLibrary, outside the loader lock and before
// chromium creates its swap chain. returns 1 on success
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

// returns TRUE: a DllMain that returns nothing hands the loader whatever is left in the register, and a zero there
// makes LoadLibrary fail on DLL_PROCESS_ATTACH. that worked by luck of the generated code, one more branch below
// was enough to turn it into a zero and the GPU process ran without the hook
#[unsafe(no_mangle)]
extern "system" fn DllMain(_: HINSTANCE, call_reason: u32, reserved: *mut ()) -> BOOL {
    if call_reason == DLL_PROCESS_ATTACH {
        debug_print!("render: DLL_PROCESS_ATTACH, waiting for render_attach");
    } else if call_reason == DLL_PROCESS_DETACH && !reserved.is_null() {
        // the process is exiting: the other threads are already gone, possibly holding one of the locks below,
        // and the system frees everything anyway (Microsoft's DllMain guidance: do no cleanup in this case)
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
