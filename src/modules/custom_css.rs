use std::{fs, path::PathBuf};

use crate::utils;

// themes embed fonts as base64 data urls
const MAX_SIZE: usize = 4 * 1024 * 1024;

pub fn css_path() -> PathBuf {
    utils::settings_dir().join("custom.css")
}

pub fn read() -> String {
    fs::read_to_string(css_path()).unwrap_or_default()
}

pub fn write(content: &str) -> Result<(), String> {
    if content.len() > MAX_SIZE {
        return Err("Custom CSS is larger than 4 MB".into());
    }
    fs::create_dir_all(utils::settings_dir()).map_err(|e| e.to_string())?;
    utils::atomic_write(&css_path(), &content).map_err(|e| e.to_string())
}

// renderer only. its CONFIG is a copy from process start, the toggle has to be read from disk
pub fn enabled_on_disk() -> bool {
    fs::read_to_string(utils::settings_dir().join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|settings| settings["customCss"].as_bool())
        .unwrap_or(true)
}

pub fn for_page() -> String {
    if !enabled_on_disk() {
        return String::new();
    }
    let css = read();
    if css.len() > MAX_SIZE { String::new() } else { css }
}

pub fn reveal() {
    let path = css_path();
    super::files::reveal(if path.exists() { &path } else { path.parent().unwrap_or(&path) });
}
