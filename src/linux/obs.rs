use crate::bridge;

// the capture plugin is d3d11 shared textures, OBS on linux captures the window through pipewire
pub fn set_plugin_installed(frame: &cef::Frame, _install: bool) {
    crate::CONFIG.lock().unwrap().set("obsCapturePlugin", false);
    crate::config::save_soon();
    let payload = serde_json::json!({
        "type": "obs-plugin",
        "ok": false,
        "message": "The OBS plugin is Windows only. On Linux add a Screen Capture (PipeWire) source for the Kute window.",
    });
    bridge::post_json_to_frame(frame, &payload.to_string());
}

pub fn handle_cli_flags() -> bool {
    false
}
