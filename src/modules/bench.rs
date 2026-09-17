use std::{env, fs, path::PathBuf, sync::LazyLock};

use crate::{app, debug_print, utils, window};

// `kute.exe --bench=hook=1,depth=1,uncap=1,ms=2000,out=C:\path\result.json` measures one process level
// configuration: it is a second browser process with its own profile, flags and timing mapping, so it
// can run next to the client. it loads the synthetic scene (frontend/modules/autoDetect), writes one
// JSON result and exits. settings that need a restart can only be compared this way
pub struct BenchConfig {
    pub hook: bool,
    pub uncap: bool,
    // CustomMaxPendingFrames of the patched cef, 1 is its default
    pub depth: u32,
    pub limit: u64,
    // left:top:right:bottom in screen pixels. without it the bench covers the spot the client last used
    pub rect: Option<[i32; 4]>,
    // handed to the page as its query string
    pub query: String,
    pub out: Option<PathBuf>,
}

pub const TIMING_MAPPING_ENV: &str = "KUTE_TIMING_MAPPING";
pub const HOOK_ENV: &str = "KUTE_BENCH_HOOK";
pub const BENCH_PATH: &str = "/kute-bench";

static CONFIG: LazyLock<Option<BenchConfig>> = LazyLock::new(|| {
    let raw = env::args().find_map(|arg| arg.strip_prefix("--bench=").map(str::to_string))?;
    let mut config = BenchConfig {
        hook: true,
        uncap: true,
        depth: 1,
        limit: 0,
        rect: None,
        query: String::new(),
        out: None,
    };
    let mut query = Vec::new();
    for pair in raw.split(',') {
        let Some((key, value)) = pair.split_once('=') else { continue };
        match key {
            "hook" => config.hook = value != "0",
            "uncap" => config.uncap = value != "0",
            "depth" => config.depth = value.parse().unwrap_or(1).max(1),
            "limit" => config.limit = value.parse().unwrap_or(0),
            "out" => config.out = Some(PathBuf::from(value)),
            "rect" => {
                let edges: Vec<i32> = value.split(':').filter_map(|edge| edge.parse().ok()).collect();
                config.rect = <[i32; 4]>::try_from(edges).ok();
            }
            // everything else (ms, settle, draws, overdraw, cpu) belongs to the page
            _ => query.push(format!("{key}={value}")),
        }
    }
    config.query = query.join("&");
    Some(config)
});

// browser process only, the subprocesses read the environment instead
pub fn config() -> Option<&'static BenchConfig> {
    CONFIG.as_ref()
}

pub fn active() -> bool {
    config().is_some()
}

pub fn url() -> String {
    let query = config().map(|c| c.query.as_str()).unwrap_or("");
    format!("https://krunker.io{BENCH_PATH}?{query}")
}

pub fn profile_dir() -> PathBuf {
    utils::settings_dir().join("bench-profile")
}

// has to run before cef initializes, the gpu process inherits the environment
pub fn prepare_environment(config: &BenchConfig) {
    unsafe {
        env::set_var(TIMING_MAPPING_ENV, "KuteFrameTimingBench");
        env::set_var(HOOK_ENV, if config.hook { "1" } else { "0" });
    }
}

// gpu process: None outside of a bench run
pub fn hook_override() -> Option<bool> {
    env::var(HOOK_ENV).ok().map(|value| value != "0")
}

pub fn timing_mapping_name() -> String {
    env::var(TIMING_MAPPING_ENV).unwrap_or_else(|_| "KuteFrameTiming".to_string())
}

pub fn flags(config: &BenchConfig) -> Vec<String> {
    let mut flags = Vec::new();
    if config.uncap {
        flags.push("--disable-frame-rate-limit".to_string());
    }
    if config.depth != 1 {
        flags.push(format!("--enable-features=CustomMaxPendingFrames:count/{}", config.depth));
    }
    flags
}

pub const STUB_PAGE: &str =
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Kute bench</title></head><body style=\"margin:0;background:#000\"></body></html>";

// the page is done: add what only the host knows, write the result and quit
pub fn finish(page_json: &str) {
    let Some(config) = config() else { return };
    let page: serde_json::Value = serde_json::from_str(page_json).unwrap_or(serde_json::Value::Null);
    let present = app::render_stats().map(|(fps, frame_ns)| serde_json::json!({ "fps": fps, "frameNs": frame_ns }));
    let result = serde_json::json!({
        "config": { "hook": config.hook, "uncap": config.uncap, "depth": config.depth, "limit": config.limit },
        "page": page,
        "present": present,
    });
    debug_print!("bench: {result}");
    if let Some(out) = &config.out {
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).ok();
        }
        utils::atomic_write(out, &result.to_string()).ok();
    }
    window::close_all();
}
