use std::sync::atomic::{AtomicBool, AtomicU64};

// layout must match SharedStats in src/app.rs
#[repr(C)]
pub(crate) struct SharedState {
    pub(crate) frame_ns: u64,
    pub(crate) fps: u64,
    pub(crate) target_fps: u64,
    // host bumps stats_request, hook answers with the interval stats and sets stats_ack to match
    pub(crate) stats_request: u64,
    pub(crate) stats_ack: u64,
    // real Present1 intervals, after the limiter
    pub(crate) present_p50_ns: u64,
    pub(crate) present_p99_ns: u64,
    pub(crate) present_max_ns: u64,
    // frame arrival intervals, before any waiting
    pub(crate) arrive_p99_ns: u64,
    pub(crate) samples: u64,
}
pub(crate) const SHARED_STATE_SIZE: usize = std::mem::size_of::<SharedState>();

// mirrors `shared!` in the host's app.rs
macro_rules! shared {
    ($ptr:expr, $field:ident) => {
        AtomicU64::from_ptr(($ptr as usize + std::mem::offset_of!(SharedState, $field)) as *mut u64)
    };
}

const INTERVAL_SAMPLES: usize = 16384;

pub(crate) struct Intervals {
    ns: Vec<u32>,
    next: usize,
    count: usize,
    last: Option<std::time::Instant>,
}

impl Intervals {
    pub(crate) fn new() -> Self {
        Intervals {
            ns: vec![0; INTERVAL_SAMPLES],
            next: 0,
            count: 0,
            last: None,
        }
    }

    pub(crate) fn mark(&mut self, now: std::time::Instant) {
        if let Some(last) = self.last {
            self.ns[self.next] = now.duration_since(last).as_nanos().min(u32::MAX as u128) as u32;
            self.next = (self.next + 1) % INTERVAL_SAMPLES;
            self.count = (self.count + 1).min(INTERVAL_SAMPLES);
        }
        self.last = Some(now);
    }

    // (p50, p99, max, count), resets the window
    pub(crate) fn take(&mut self) -> (u64, u64, u64, u64) {
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

pub(crate) static SHARED_MEM_PTR: AtomicU64 = AtomicU64::new(0);
pub(crate) static MISSING_TIMING_MAPPING_LOGGED: AtomicBool = AtomicBool::new(false);
