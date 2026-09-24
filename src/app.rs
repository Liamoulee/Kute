use crate::utils::config;
use crate::{constants, handlers, modules, renderer, utils, window};
use cef::{rc::*, *};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use std::{
    env, fs, io, result,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use windows::Win32::Foundation::*;
use windows::Win32::System::Memory::*;
use windows::core::*;

pub fn init_fs() -> result::Result<(), io::Error> {
    let client_dir = utils::settings_dir();
    let swap_dir = client_dir.join("swapper");
    let scripts_dir = client_dir.join("scripts").join("social");

    let resources_dir = utils::exe_dir().join("resources");

    fs::create_dir_all(&swap_dir)?;
    // most common swap, players get the casing wrong otherwise
    fs::create_dir_all(swap_dir.join("css"))?;
    fs::create_dir_all(&scripts_dir)?;
    fs::create_dir_all(&resources_dir)?;
    Ok(())
}

// layout must match SharedState in render-dll/src/lib.rs
#[repr(C)]
pub(crate) struct SharedStats {
    pub(crate) frame_ns: u64,
    pub(crate) fps: u64,
    pub(crate) target_fps: u64,
    pub(crate) stats_request: u64,
    pub(crate) stats_ack: u64,
    pub(crate) present_p50_ns: u64,
    pub(crate) present_p99_ns: u64,
    pub(crate) present_max_ns: u64,
    pub(crate) arrive_p99_ns: u64,
    pub(crate) samples: u64,
}
const SHARED_STATS_SIZE: usize = std::mem::size_of::<SharedStats>();

pub(crate) static SHARED_STATS_PTR: AtomicU64 = AtomicU64::new(0);

// one field of the shared mapping as an atomic. the gpu process writes the same memory, never touch it plainly
// stats_request/stats_ack: request Release -> hook Acquire, payload, ack Release -> host Acquire, then read payload
macro_rules! shared {
    ($field:ident) => {{
        let ptr = SHARED_STATS_PTR.load(Ordering::SeqCst);
        (ptr != 0).then(|| unsafe { AtomicU64::from_ptr((ptr as usize + std::mem::offset_of!(SharedStats, $field)) as *mut u64) })
    }};
}

// render.dll opens this in the gpu process, so it has to exist before initialize()
pub fn create_frame_timing_mapping() {
    let fps_limit = match modules::bench::config() {
        Some(bench) => bench.limit,
        None => config("gameFpsLimit", 0),
    };
    let name = HSTRING::from(modules::bench::timing_mapping_name());
    unsafe {
        if let Ok(mapping) = CreateFileMappingW(INVALID_HANDLE_VALUE, None, PAGE_READWRITE, 0, SHARED_STATS_SIZE as u32, &name) {
            let view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, SHARED_STATS_SIZE);
            if !view.Value.is_null() {
                std::ptr::write_bytes(view.Value as *mut u8, 0, SHARED_STATS_SIZE);
                SHARED_STATS_PTR.store(view.Value as u64, Ordering::SeqCst);
                set_target_fps(fps_limit);
            }
        }
    }
}

pub fn set_target_fps(fps_limit: u64) {
    if let Some(target) = shared!(target_fps) {
        target.store(fps_limit, Ordering::Relaxed);
    }
}

static STATS_REQUEST_LOCK: Mutex<()> = Mutex::new(());

// present interval distribution since the last call. blocks up to 150 ms, never call on the UI thread
pub fn take_present_intervals() -> Option<(u64, u64, u64, u64, u64)> {
    let _one_at_a_time = STATS_REQUEST_LOCK.lock().unwrap();
    let (request_field, ack) = (shared!(stats_request)?, shared!(stats_ack)?);
    let request = request_field.load(Ordering::Relaxed).wrapping_add(1);
    request_field.store(request, Ordering::Release);
    let started = std::time::Instant::now();
    while ack.load(Ordering::Acquire) != request {
        if started.elapsed() > std::time::Duration::from_millis(150) {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    Some((
        shared!(present_p50_ns)?.load(Ordering::Relaxed),
        shared!(present_p99_ns)?.load(Ordering::Relaxed),
        shared!(present_max_ns)?.load(Ordering::Relaxed),
        shared!(arrive_p99_ns)?.load(Ordering::Relaxed),
        shared!(samples)?.load(Ordering::Relaxed),
    ))
}

// (fps, frame_ns) from the present hook
pub fn render_stats() -> Option<(u64, u64)> {
    Some((shared!(fps)?.load(Ordering::Relaxed), shared!(frame_ns)?.load(Ordering::Relaxed)))
}

pub static DISCORD: Mutex<Option<DiscordIpcClient>> = Mutex::new(None);

static FLAGS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn angle_backend_switch(option: &str) -> Option<&'static str> {
    match option {
        "D3D11" => Some("d3d11"),
        "D3D11on12" => Some("d3d11on12"),
        "OpenGL" => Some("gl"),
        "Vulkan" => Some("vulkan"),
        _ => None,
    }
}

fn color_profile_switch(option: &str) -> Option<&'static str> {
    match option {
        "sRGB" => Some("srgb"),
        "Display P3 D65" => Some("display-p3-d65"),
        "Extended sRGB" => Some("extended-srgb"),
        "scRGB linear" => Some("scrgb-linear"),
        "HDR10" => Some("hdr10"),
        _ => None,
    }
}

pub fn load_flags() {
    let mut flags = modules::flaglist::load();
    if let Some(bench) = modules::bench::config() {
        flags.extend(modules::bench::flags(bench));
    } else if config("uncapFps", true) {
        flags.push("--disable-frame-rate-limit".to_string());
    }
    if let Some(backend) = angle_backend_switch(&config("angleBackend", "Default".to_string())) {
        flags.push(format!("--use-angle={backend}"));
    }
    if let Some(profile) = color_profile_switch(&config("colorProfile", "Default".to_string())) {
        flags.push(format!("--force-color-profile={profile}"));
    }
    // patch 03 of our libcef. disable it in user_flags.json to get the old input.rs WM_INPUT filter back
    flags.push("--enable-features=KuteRawInputMovementOnly".to_string());
    *FLAGS.lock().unwrap() = flags;
}

pub fn has_flag(wanted: &str) -> bool {
    FLAGS.lock().unwrap().iter().any(|flag| flag == wanted)
}

// --disable-features wins, like in chromium
pub fn feature_enabled(name: &str) -> bool {
    let listed = |switch: &str| {
        FLAGS
            .lock()
            .unwrap()
            .iter()
            .filter_map(|flag| flag.strip_prefix(switch))
            .any(|list| list.split(',').any(|feature| feature.split(':').next() == Some(name)))
    };
    listed("--enable-features=") && !listed("--disable-features=")
}

pub fn prepare_profile() {
    let profile_dir = cache_dir().join("Default");
    if let Ok(entries) = fs::read_dir(profile_dir.join("Sessions")) {
        for entry in entries.flatten() {
            fs::remove_file(entry.path()).ok();
        }
    }

    let path = profile_dir.join("Preferences");
    let mut prefs = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let before = prefs.to_string();

    let wanted = [
        ("profile.exit_type", serde_json::Value::String("Normal".to_string())),
        ("credentials_enable_service", serde_json::Value::Bool(false)),
        ("credentials_enable_autosignin", serde_json::Value::Bool(false)),
        ("autofill.profile_enabled", serde_json::Value::Bool(false)),
        ("autofill.credit_card_enabled", serde_json::Value::Bool(false)),
        ("translate.enabled", serde_json::Value::Bool(false)),
    ];
    for (key, value) in wanted {
        let mut node = &mut prefs;
        for part in key.split('.') {
            if !node.is_object() {
                *node = serde_json::json!({});
            }
            node = node.as_object_mut().unwrap().entry(part).or_insert(serde_json::Value::Null);
        }
        *node = value;
    }

    let after = prefs.to_string();
    if after != before {
        fs::create_dir_all(&profile_dir).ok();
        utils::atomic_write(&path, &after).ok();
    }
}

// one browser process per profile, so bench gets its own
fn cache_dir() -> std::path::PathBuf {
    if modules::bench::active() {
        modules::bench::profile_dir()
    } else {
        utils::settings_dir().join("cef")
    }
}

pub fn settings() -> Settings {
    let cache_dir = cache_dir();
    let log_file = utils::settings_dir().join("cef_debug.log");
    Settings {
        // a plain exe can't host the sandbox, needs the bootstrap.exe model
        no_sandbox: 1,
        // krunker gates client features on this user agent
        user_agent: CefString::from("Electron"),
        locale: CefString::from("en-US"),
        accept_language_list: CefString::from("en-US,en"),
        root_cache_path: CefString::from(cache_dir.to_string_lossy().as_ref()),
        cache_path: CefString::from(cache_dir.to_string_lossy().as_ref()),
        persist_session_cookies: 1,
        background_color: 0xFF000000,
        log_file: CefString::from(log_file.to_string_lossy().as_ref()),
        log_severity: if cfg!(feature = "verbose-logs") {
            LogSeverity::WARNING
        } else {
            LogSeverity::DISABLE
        },
        remote_debugging_port: env::var("KUTE_DEBUG_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(0),
        ..Default::default()
    }
}

// same storage as the global context, but with our handler (the global one can't have one)
pub fn request_context() -> Option<RequestContext> {
    let cache_dir = cache_dir();
    let settings = RequestContextSettings {
        cache_path: CefString::from(cache_dir.to_string_lossy().as_ref()),
        persist_session_cookies: 1,
        accept_language_list: CefString::from("en-US,en"),
        ..Default::default()
    };
    let mut handler = handlers::KuteRequestContextHandler::new();
    request_context_create_context(Some(&settings), Some(&mut handler))
}

pub fn browser_settings() -> BrowserSettings {
    BrowserSettings {
        background_color: 0xFF000000,
        chrome_status_bubble: State::DISABLED,
        chrome_zoom_bubble: State::DISABLED,
        ..Default::default()
    }
}

// merge with what cef already set
fn merge_list_switch(cmd: &mut CommandLine, key: &str, value: &str) {
    let name = CefString::from(key);
    let existing = if cmd.has_switch(Some(&name)) != 0 {
        utils::cef_to_string(&cmd.switch_value(Some(&name)))
    } else {
        String::new()
    };
    let mut parts: Vec<&str> = existing.split(',').filter(|s| !s.is_empty()).collect();
    for v in value.split(',').filter(|s| !s.is_empty()) {
        if !parts.contains(&v) {
            parts.push(v);
        }
    }
    let joined = parts.join(",");
    cmd.append_switch_with_value(Some(&name), Some(&CefString::from(joined.as_str())));
}

wrap_browser_process_handler! {
    struct KuteBrowserProcessHandler;

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            if modules::bench::active() {
                window::create_main_window();
                return;
            }

            if config("discordRPC", true) {
                let mut client = DiscordIpcClient::new(constants::DISCORD_CLIENT_ID);
                client.connect().ok();
                *DISCORD.lock().unwrap() = Some(client);
            }

            window::create_main_window();

            #[cfg(feature = "auto-update")]
            if config("checkUpdates", true) {
                std::thread::spawn(|| {
                    modules::lifecycle::check_major_update();
                    // new bundle applies on the next navigation
                    modules::lifecycle::check_minor_update();
                });
            }
        }
    }
}

wrap_app! {
    pub struct KuteApp;

    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(KuteBrowserProcessHandler::new())
        }

        fn render_process_handler(&self) -> Option<RenderProcessHandler> {
            Some(renderer::KuteRenderProcessHandler::new())
        }

        fn on_before_command_line_processing(&self, process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            // subprocesses inherit the switches
            if !process_type.map(|t| t.to_string().is_empty()).unwrap_or(true) {
                return;
            }
            let Some(cmd) = command_line else { return };

            for flag in FLAGS.lock().unwrap().iter() {
                let flag = flag.trim_start_matches("--");
                match flag.split_once('=') {
                    Some((k, v)) if k == "disable-features" || k == "enable-features" => merge_list_switch(cmd, k, v),
                    Some((k, v)) => cmd.append_switch_with_value(Some(&CefString::from(k)), Some(&CefString::from(v))),
                    None => cmd.append_switch(Some(&CefString::from(flag))),
                }
            }
            cmd.append_switch(Some(&CefString::from("disable-pinch")));
            // otherwise chromium restores the last session in its own window
            cmd.append_switch(Some(&CefString::from("no-startup-window")));
            cmd.append_switch(Some(&CefString::from("hide-crash-restore-bubble")));
        }
    }
}
