use std::{
    cell,
    collections::HashMap,
    ffi::c_void,
    sync::{
        LazyLock, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    thread,
};
use windows::Win32::{Foundation::*, Graphics::Dxgi::*, System::Threading::*};
use windows::core::*;

use crate::{capture, shared::*, swapchain::*};

const WAIT_TIMEOUT_MS: u32 = 100;
const WAIT_TIMEOUTS_BEFORE_PAUSE: u32 = 3;
const WAIT_PAUSE: std::time::Duration = std::time::Duration::from_secs(2);
const WAIT_PROBE_MS: u32 = 50;
// a gap this long is a pause (hidden window, loading), not a frame
const PAUSE_NS: u64 = 250_000_000;

#[allow(clippy::type_complexity)]
pub(crate) static mut ORIGINAL_PRESENT: Option<unsafe fn(*mut c_void, u32, DXGI_PRESENT, *const DXGI_PRESENT_PARAMETERS) -> HRESULT> = None;

static GLOBAL_LIMIT_CLOCK: LazyLock<RwLock<Option<std::time::Instant>>> = LazyLock::new(|| RwLock::new(None));

#[link(name = "Avrt")]
unsafe extern "system" {
    fn AvSetMmThreadCharacteristicsW(task_name: PCWSTR, task_index: *mut u32) -> HANDLE;
}

pub(crate) unsafe extern "system" fn present_hk(
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

        // only the game's chain feeds the stats
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
                        // don't average pauses in, restart instead
                        if frame_ns > PAUSE_NS {
                            avg.set(0);
                            return;
                        }
                        let next = if avg.get() == 0 { frame_ns } else { (avg.get() * 31 + frame_ns) / 32 };
                        avg.set(next);
                        // frame_ns can be 0 within timer resolution
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
            // hidden windows never signal: pause waiting after a few timeouts, then probe. never drop the handle,
            // it's what marks the game's chain
            let paused_until = WAIT_PAUSED_UNTIL.get();
            let probing = paused_until.is_some();
            if paused_until.is_none_or(|until| wait_started >= until) {
                let wait_result = WaitForSingleObjectEx(h.0, if probing { WAIT_PROBE_MS } else { WAIT_TIMEOUT_MS }, false);
                if wait_result == WAIT_FAILED {
                    // broken handle, will never work again
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

        // only valid on chains created with ALLOW_TEARING, else DXGI_ERROR_INVALID_CALL
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
            // answer stats requests after the present, sorting shouldn't delay the frame
            let request = shared!(ptr, stats_request).load(Ordering::Acquire);
            if request != shared!(ptr, stats_ack).load(Ordering::Relaxed) {
                let (p50, p99, max, samples) = PRESENTS.with_borrow_mut(|presents| presents.take());
                let (_, arrive_p99, _, _) = ARRIVALS.with_borrow_mut(|arrivals| arrivals.take());
                shared!(ptr, present_p50_ns).store(p50, Ordering::Relaxed);
                shared!(ptr, present_p99_ns).store(p99, Ordering::Relaxed);
                shared!(ptr, present_max_ns).store(max, Ordering::Relaxed);
                shared!(ptr, arrive_p99_ns).store(arrive_p99, Ordering::Relaxed);
                shared!(ptr, samples).store(samples, Ordering::Relaxed);
                // ack last, the host reads the payload once it sees it
                shared!(ptr, stats_ack).store(request, Ordering::Release);
            }
        }

        let present_ns = if cfg!(feature = "verbose-logs") {
            present_started.elapsed().as_nanos() as u64
        } else {
            0
        };

        // limiter sleeps after the real present, sleeping before it made input a whole frame older
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

            // schedule from the deadline, not the wakeup, so overshoot doesn't add up
            let after = std::time::Instant::now();
            let next_ref = if after.duration_since(deadline) > target_frame_time {
                after
            } else {
                deadline
            };
            *GLOBAL_LIMIT_CLOCK.write().unwrap() = Some(next_ref);
        }

        if cfg!(feature = "verbose-logs") {
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
