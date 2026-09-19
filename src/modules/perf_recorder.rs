// dev only flight recorder (_docs/flight-recorder-plan.md): with --perf-recorder (or KUTE_PERF_RECORDER=1) Chromium traces
// all processes (renderer, GPU, browser) into a ring buffer while the player plays. F8 marks the moment, records 5 s more
// and writes the trace plus a context.json to Documents\kute\captures\<date_time>\, then the ring starts again.
// tracing costs something at uncapped FPS, so this is a debugging tool, never on for players
use cef::{rc::*, *};
use std::{
    cell::{Cell, RefCell},
    env, fs,
    io::{BufWriter, Write},
    path::PathBuf,
    sync::{Mutex, OnceLock, mpsc},
    thread,
};
use windows::Win32::System::SystemInformation::GetLocalTime;

use crate::{bridge, debug_print, modules::devtools, utils};

const ARG: &str = "--perf-recorder";
const ENV: &str = "KUTE_PERF_RECORDER";
const AFTER_KEY_MS: i64 = 5000;
// sized in memory, not seconds: how far back it reaches depends on the frame rate
const BUFFER_KB: u32 = 512 * 1024;
// what the DevTools performance panel records (tasks of every thread including the GPU process's, the game's frames,
// JS samples, GC) plus the GPU process's own events that only fire when something happens (shader compiles, uploads).
// toplevel, cc, viz and gpu log several events per frame on every thread: at 800 FPS in the menu they made 40 s of
// trace 2.4 GB and took 1.5 min to write
const CATEGORIES: &[&str] = &[
    "devtools.timeline",
    "disabled-by-default-devtools.timeline",
    "v8",
    "disabled-by-default-v8.gc",
    "disabled-by-default-v8.cpu_profiler",
    "gpu.angle",
    "gpu.service",
    "gpu.decoder",
    "loading",
];

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Off,
    Recording,
    Capturing,
}

enum Job {
    Begin(PathBuf),
    Chunk(Vec<u8>),
    Finish { browser_id: i32, context: String },
}

// UI thread state. the observer is dropped when its registration is
thread_local! {
    static PHASE: Cell<Phase> = const { Cell::new(Phase::Off) };
    static REGISTRATION: RefCell<Option<Registration>> = const { RefCell::new(None) };
}
static PAGE_CONTEXT: Mutex<Option<String>> = Mutex::new(None);
static KEY_TIME: Mutex<String> = Mutex::new(String::new());
static WRITER: OnceLock<mpsc::Sender<Job>> = OnceLock::new();

pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| utils::has_arg(ARG) || env::var(ENV).is_ok_and(|value| value != "0"))
}

pub fn is_arg(arg: &str) -> bool {
    arg == ARG
}

// hundreds of MB of events arrive on the UI thread, so they are written on a thread of their own
fn writer() -> &'static mpsc::Sender<Job> {
    WRITER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<Job>();
        thread::spawn(move || {
            let mut dir = PathBuf::new();
            let mut file: Option<BufWriter<fs::File>> = None;
            for job in receiver {
                match job {
                    Job::Begin(path) => {
                        dir = path;
                        file = None;
                    }
                    Job::Chunk(events) => {
                        if file.is_none() {
                            let opened = fs::create_dir_all(&dir).and_then(|_| fs::File::create(dir.join("trace.json")));
                            match opened {
                                Ok(created) => {
                                    let mut created = BufWriter::with_capacity(4 << 20, created);
                                    let _ = created.write_all(b"{\"traceEvents\":[\n");
                                    file = Some(created);
                                }
                                Err(err) => debug_print!("perf recorder: cannot write {}: {err}", dir.display()),
                            }
                        } else if let Some(out) = file.as_mut() {
                            let _ = out.write_all(b",\n");
                        }
                        if let Some(out) = file.as_mut() {
                            let _ = out.write_all(&events);
                        }
                    }
                    Job::Finish { browser_id, context } => {
                        let traced = file.take().is_some_and(|mut out| out.write_all(b"\n]}\n").and_then(|_| out.flush()).is_ok());
                        let _ = fs::create_dir_all(&dir);
                        let _ = fs::write(dir.join("context.json"), context);
                        let message = serde_json::json!({ "perfCapture": "saved", "dir": dir.display().to_string(), "traced": traced });
                        bridge::post_json_later(browser_id, message.to_string());
                    }
                }
            }
        });
        sender
    })
}

wrap_dev_tools_message_observer! {
    struct TraceObserver;

    impl DevToolsMessageObserver {
        fn on_dev_tools_event(&self, browser: Option<&mut Browser>, method: Option<&CefString>, params: Option<&[u8]>) {
            let (Some(method), Some(params)) = (method, params) else { return };
            match method.to_string().as_str() {
                // {"value":[{event},{event},...]}: the array's inside goes to the file as it is, no parsing
                "Tracing.dataCollected" => {
                    let start = params.iter().position(|&b| b == b'[');
                    let end = params.iter().rposition(|&b| b == b']');
                    if let (Some(start), Some(end)) = (start, end)
                        && end > start + 1
                    {
                        let _ = writer().send(Job::Chunk(params[start + 1..end].to_vec()));
                    }
                }
                "Tracing.tracingComplete" => {
                    let Some(browser) = browser else { return };
                    let _ = writer().send(Job::Finish { browser_id: browser.identifier(), context: context() });
                    start(browser);
                }
                _ => {}
            }
        }

        fn on_dev_tools_method_result(&self, _browser: Option<&mut Browser>, message_id: ::std::os::raw::c_int, success: ::std::os::raw::c_int, result: Option<&[u8]>) {
            if success == 0 {
                debug_print!("perf recorder: devtools call {message_id} failed: {}", String::from_utf8_lossy(result.unwrap_or_default()));
            }
        }
    }
}

// main browser attached
pub fn load(browser: &Browser) {
    if !enabled() {
        return;
    }
    let Some(host) = browser.host() else { return };
    let mut observer = TraceObserver::new();
    if let Some(registration) = host.add_dev_tools_message_observer(Some(&mut observer)) {
        REGISTRATION.set(Some(registration));
    }
    start(browser);
    debug_print!("perf recorder: tracing, F8 saves the last seconds");
}

fn start(browser: &Browser) {
    let params = serde_json::json!({
        "transferMode": "ReportEvents",
        "traceConfig": {
            "recordMode": "recordContinuously",
            "traceBufferSizeInKb": BUFFER_KB,
            "includedCategories": CATEGORIES,
        },
    });
    devtools::send(browser, "Tracing.start", params);
    PHASE.set(Phase::Recording);
}

wrap_task! {
    struct EndTask {
        browser_id: i32,
    }

    impl Task {
        fn execute(&self) {
            if let Some(browser) = crate::window::browser_by_id(self.browser_id) {
                devtools::send(&browser, "Tracing.end", serde_json::json!({}));
            }
        }
    }
}

// F8
pub fn capture(browser: &Browser) {
    if !enabled() || PHASE.get() != Phase::Recording {
        return;
    }
    PHASE.set(Phase::Capturing);

    let now = unsafe { GetLocalTime() };
    let stamp = format!(
        "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
        now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond
    );
    *KEY_TIME.lock().unwrap() = format!("{stamp}.{:03}", now.wMilliseconds);
    *PAGE_CONTEXT.lock().unwrap() = None;
    let _ = writer().send(Job::Begin(utils::settings_dir().join("captures").join(&stamp)));

    // the page marks the moment in the trace (console.timeStamp "kute-f8") and answers with its state
    bridge::post_json(browser, r#"{"perfCapture":"mark"}"#);
    let mut task = EndTask::new(browser.identifier());
    post_delayed_task(ThreadId::UI, Some(&mut task), AFTER_KEY_MS);
    debug_print!("perf recorder: F8 at {stamp}, saving in {} s", AFTER_KEY_MS / 1000);
}

// "perf-context <json>" from the page
pub fn set_page_context(json: &str) {
    if enabled() && json.len() <= 256 * 1024 {
        *PAGE_CONTEXT.lock().unwrap() = Some(json.to_string());
    }
}

fn context() -> String {
    let read = |name: &str| {
        fs::read_to_string(utils::settings_dir().join(name))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    };
    let page = PAGE_CONTEXT
        .lock()
        .unwrap()
        .take()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let context = serde_json::json!({
        "keyPressed": KEY_TIME.lock().unwrap().clone(),
        "secondsAfterKey": AFTER_KEY_MS / 1000,
        "client": env!("CARGO_PKG_VERSION"),
        "bundle": crate::JS_VERSION.lock().unwrap().clone(),
        "page": page,
        "settings": read("settings.json"),
        "userFlags": read("user_flags.json"),
    });
    serde_json::to_string_pretty(&context).unwrap_or_default()
}
