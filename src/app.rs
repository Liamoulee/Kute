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
    fs::create_dir_all(&scripts_dir)?;
    fs::create_dir_all(&resources_dir)?;

    // user_flags.json and user_blocklist.json are created with their example content by
    // modules::flaglist and modules::blocklist when they are missing or empty
    Ok(())
}

// 24 bytes, layout must match SharedState in render-dll/src/lib.rs
#[repr(C)]
pub(crate) struct SharedStats {
    pub(crate) frame_ns: u64,
    pub(crate) fps: u64,
    pub(crate) target_fps: u64,
}

pub(crate) static SHARED_STATS_PTR: AtomicU64 = AtomicU64::new(0);

// the gpu subprocess opens this mapping when render.dll attaches, so it has to exist before initialize()
pub fn create_frame_timing_mapping() {
    let fps_limit = config("renderFpsLimit", 0);
    unsafe {
        if let Ok(mapping) = CreateFileMappingW(INVALID_HANDLE_VALUE, None, PAGE_READWRITE, 0, 24, w!("KuteFrameTiming")) {
            let view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, 24);
            if !view.Value.is_null() {
                std::ptr::write_bytes(view.Value as *mut u8, 0, 24);
                (*(view.Value as *mut SharedStats)).target_fps = fps_limit;
                SHARED_STATS_PTR.store(view.Value as u64, Ordering::SeqCst);
            }
        }
    }
}

pub fn set_target_fps(fps_limit: u64) {
    let ptr = SHARED_STATS_PTR.load(Ordering::SeqCst);
    if ptr != 0 {
        unsafe {
            (*(ptr as *mut SharedStats)).target_fps = fps_limit;
        }
    }
}

// (fps, frame_ns) as published by the present hook
pub fn render_stats() -> Option<(u64, u64)> {
    let ptr = SHARED_STATS_PTR.load(Ordering::SeqCst);
    if ptr == 0 {
        return None;
    }
    let shared = unsafe { &*(ptr as *const SharedStats) };
    Some((shared.fps, shared.frame_ns))
}

pub static DISCORD: Mutex<Option<DiscordIpcClient>> = Mutex::new(None);

static FLAGS: Mutex<Vec<String>> = Mutex::new(Vec::new());

// the select options of cSettings.json mapped to what chromium accepts
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
    if config("uncapFps", true) {
        flags.push("--disable-frame-rate-limit".to_string());
    }
    if let Some(backend) = angle_backend_switch(&config("angleBackend", "Default".to_string())) {
        flags.push(format!("--use-angle={backend}"));
    }
    if let Some(profile) = color_profile_switch(&config("colorProfile", "Default".to_string())) {
        flags.push(format!("--force-color-profile={profile}"));
    }
    *FLAGS.lock().unwrap() = flags;
}

// chromium's session service records our game tab and its startup code restores it into a plain
// chrome window on the next start, so the recorded session is dropped and the profile is marked
// as cleanly exited before every start. the same pass pins the profile preferences that mirror
// the WebView2 settings (no password or autofill prompts, no translate bubble)
pub fn prepare_profile() {
    let profile_dir = utils::settings_dir().join("cef").join("Default");
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

pub fn settings() -> Settings {
    let cache_dir = utils::settings_dir().join("cef");
    let log_file = utils::settings_dir().join("cef_debug.log");
    Settings {
        // a normal exe cannot host CEF's windows sandbox (that needs the bootstrap.exe model)
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

// shares the global storage (same cache_path) but carries our handler, which the global context cannot
pub fn request_context() -> Option<RequestContext> {
    let cache_dir = utils::settings_dir().join("cef");
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

// --disable-features and --enable-features are merged with what CEF already set
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
                    // the renderer reads resources/bundle.js on every page load, so a new bundle applies on the next navigation
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
            // subprocesses inherit the browser's switches
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
            // mirrors SetIsPinchZoomEnabled(false)
            cmd.append_switch(Some(&CefString::from("disable-pinch")));
            // chromium's startup browser creator would restore the last session in its own window
            cmd.append_switch(Some(&CefString::from("no-startup-window")));
            cmd.append_switch(Some(&CefString::from("hide-crash-restore-bubble")));
        }
    }
}
