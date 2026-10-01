use crate::constants;
use cef::{rc::*, *};

fn post(frame: &Frame, is_json: bool, payload: &str) {
    let Some(mut message) = process_message_create(Some(&CefString::from(constants::MSG_TO_PAGE))) else {
        return;
    };
    let Some(args) = message.argument_list() else { return };
    args.set_bool(0, i32::from(is_json));
    args.set_string(1, Some(&CefString::from(payload)));
    frame.send_process_message(ProcessId::RENDERER, Some(&mut message));
}

pub fn post_json_to_frame(frame: &Frame, json: &str) {
    post(frame, true, json);
}

pub fn post_string_to_frame(frame: &Frame, text: &str) {
    post(frame, false, text);
}

pub fn post_json(browser: &Browser, json: &str) {
    if let Some(frame) = browser.main_frame() {
        post_json_to_frame(&frame, json);
    }
}

pub fn post_string(browser: &Browser, text: &str) {
    if let Some(frame) = browser.main_frame() {
        post_string_to_frame(&frame, text);
    }
}

pub fn send_info(frame: &Frame) {
    let version = env!("CARGO_PKG_VERSION");
    let mut info_map = serde_json::Map::new();
    info_map.insert("settings".to_string(), serde_json::json!(&*crate::CONFIG.lock().unwrap()));
    info_map.insert("version".to_string(), serde_json::Value::String(version.to_string()));
    info_map.insert("apiBase".to_string(), serde_json::Value::String(crate::utils::api_url()));
    info_map.insert(
        "hostFeatures".to_string(),
        serde_json::json!([
            "matchmaker",
            "dev-proof",
            "kute-icons",
            "script-manager",
            "audio-fix",
            "spotify",
            "custom-css",
            "swapper-editor",
            "x3d-cores",
            "custom-sky",
            "performance-mode",
            "cef-patches",
            "hybrid-gpu",
            "autodetect-v2"
        ]),
    );

    // restart-only settings as this process runs them, the page compares them with the stored ones
    let mut running: serde_json::Map<String, serde_json::Value> = crate::app::PATCHES
        .iter()
        .map(|patch| (patch.setting.to_string(), crate::app::feature_enabled(patch.feature).into()))
        .collect();
    running.insert("hardFlip".to_string(), (*crate::app::HOOK_AT_START.get().unwrap_or(&true)).into());
    info_map.insert("running".to_string(), running.into());

    // who holds the fps limit: chromium's display scheduler (patch 08) or the present hook with the bundle's busy wait fallback
    let limiter = if crate::app::feature_enabled("KuteFrameLimiter") { "viz" } else { "hook" };
    info_map.insert("frameLimiter".to_string(), serde_json::Value::String(limiter.to_string()));

    if crate::modules::dev::has_token() {
        info_map.insert("dev".to_string(), serde_json::Value::Bool(true));
    }

    let launch_args = crate::LAUNCH_ARGS.lock().unwrap();
    if !launch_args.is_empty() {
        info_map.insert("launchArgs".to_string(), serde_json::Value::String(launch_args.join(" ")));
    }
    drop(launch_args);

    let info_json = serde_json::to_string_pretty(&info_map).unwrap();
    post_json_to_frame(frame, &info_json);
}

wrap_task! {
    pub struct PostJsonTask {
        browser_id: i32,
        json: String,
    }

    impl Task {
        fn execute(&self) {
            if let Some(browser) = crate::window::browser_by_id(self.browser_id) {
                post_json(&browser, &self.json);
            }
        }
    }
}

// usable from any thread
pub fn post_json_later(browser_id: i32, json: String) {
    let mut task = PostJsonTask::new(browser_id, json);
    post_task(ThreadId::UI, Some(&mut task));
}
