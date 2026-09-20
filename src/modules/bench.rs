use std::{
    env, fs,
    path::PathBuf,
    process::Command,
    sync::{
        LazyLock,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use cef::{rc::*, *};

use crate::{app, bridge, debug_print, utils, window};

// `kute.exe --bench=hook=1,depth=1,uncap=1,ms=2000,out=C:\path\result.json`
pub struct BenchConfig {
    pub hook: bool,
    pub uncap: bool,
    // CustomMaxPendingFrames of the patched cef, 1 is its default
    pub depth: u32,
    pub limit: u64,
    // CDP CPU throttling rate for the page, 1 is off
    pub throttle: f32,
    // started by the client's auto-detect: borderless over the client, takes no input, cannot be closed by hand
    pub locked: bool,
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
        throttle: 1.0,
        locked: false,
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
            "throttle" => config.throttle = value.parse().unwrap_or(1.0),
            "locked" => config.locked = value != "0",
            "out" => config.out = Some(PathBuf::from(value)),
            "rect" => {
                let edges: Vec<i32> = value.split(':').filter_map(|edge| edge.parse().ok()).collect();
                config.rect = <[i32; 4]>::try_from(edges).ok();
            }
            // everything else (ms, settle, draws, overdraw, cpu) belongs to the page
            _ => query.push(format!("{key}={value}")),
        }
    }
    // without the hook nothing limits at the swap chain, the page holds the rate itself (like gameFpsLimit.js does)
    if !config.hook && config.limit > 0 {
        query.push(format!("cap={}", config.limit));
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
    let intervals = if config.hook { app::take_present_intervals() } else { None };
    let present = app::render_stats().map(|(fps, frame_ns)| {
        serde_json::json!({
            "fps": fps,
            "frameNs": frame_ns,
            // ms, measured by the hook itself with the full clock resolution
            "p50": intervals.map(|i| i.0 as f64 / 1e6),
            "p99": intervals.map(|i| i.1 as f64 / 1e6),
            "max": intervals.map(|i| i.2 as f64 / 1e6),
            "arriveP99": intervals.map(|i| i.3 as f64 / 1e6),
            "samples": intervals.map(|i| i.4),
        })
    });
    let result = serde_json::json!({
        "config": { "hook": config.hook, "uncap": config.uncap, "depth": config.depth, "limit": config.limit, "throttle": config.throttle },
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
    // the regular close can hang on a window that takes no input, and whoever started this process waits for
    // it to end. the result is on disk and the profile is a throwaway, so there is nothing to lose
    thread::spawn(|| {
        thread::sleep(Duration::from_millis(1200));
        std::process::exit(0);
    });
}

static MATRIX_RUNNING: AtomicBool = AtomicBool::new(false);
// a bench process takes under four seconds, anything beyond this hangs and gets killed
const BENCH_TIMEOUT: Duration = Duration::from_secs(15);

wrap_task! {
    struct MatrixDoneTask {
        browser_id: i32,
        json: String,
    }

    impl Task {
        fn execute(&self) {
            MATRIX_RUNNING.store(false, Ordering::SeqCst);
            if let Some(browser) = window::browser_by_id(self.browser_id) {
                window::set_browser_visible(&browser, true);
                bridge::post_json(&browser, &self.json);
            }
        }
    }
}

fn run_one(config: &str, step: usize, steps: usize, rect: [i32; 4], exe: &PathBuf) -> serde_json::Value {
    let out = env::temp_dir().join(format!("kute-bench-{}-{step}.json", std::process::id()));
    fs::remove_file(&out).ok();
    let [left, top, right, bottom] = rect;
    let argument = format!(
        "--bench={config},step={step},steps={steps},locked=1,rect={left}:{top}:{right}:{bottom},out={}",
        out.to_string_lossy()
    );
    let Ok(mut child) = Command::new(exe).arg(argument).spawn() else {
        return serde_json::Value::Null;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < BENCH_TIMEOUT => thread::sleep(Duration::from_millis(50)),
            _ => {
                debug_print!("bench: {config} timed out, killing it");
                child.kill().ok();
                child.wait().ok();
                break;
            }
        }
    }
    let result = fs::read_to_string(&out)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(serde_json::Value::Null);
    fs::remove_file(&out).ok();
    result
}

pub fn run_matrix(browser: &Browser, configs: Vec<String>) {
    if MATRIX_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let browser_id = browser.identifier();
    let Some(rect) = window::client_rect_on_screen(browser) else {
        MATRIX_RUNNING.store(false, Ordering::SeqCst);
        bridge::post_json(browser, &serde_json::json!({ "benchMatrix": [] }).to_string());
        return;
    };
    window::set_browser_visible(browser, false);

    let exe = env::current_exe().unwrap_or_default();
    thread::spawn(move || {
        let mut results: Vec<serde_json::Value> = Vec::new();
        for (index, config) in configs.iter().enumerate() {
            // "limit=auto" means a bit below what the first configuration reached uncapped. without such a
            // result (it failed, or this matrix starts with a capped configuration) there is nothing to derive
            // it from, and the old minimum of 30 turned that case into a 30 FPS bench that loses against
            // everything. the caller resolves the number itself when it replays a configuration
            let first_fps = results.first().and_then(|first| first["page"]["stats"]["fps"].as_f64()).unwrap_or(0.0);
            let config = if first_fps > 0.0 {
                let auto_limit = (((first_fps * 0.9) / 5.0).round() * 5.0).max(30.0) as u64;
                config.replace("limit=auto", &format!("limit={auto_limit}"))
            } else {
                if config.contains("limit=auto") {
                    debug_print!("bench: {config} has no uncapped result to derive its cap from, running it uncapped");
                }
                config.replace(",limit=auto", "").replace("limit=auto", "")
            };
            results.push(run_one(&config, index + 1, configs.len(), rect, &exe));
        }
        let json = serde_json::json!({ "benchMatrix": results }).to_string();
        let mut task = MatrixDoneTask::new(browser_id, json);
        post_task(ThreadId::UI, Some(&mut task));
    });
}
