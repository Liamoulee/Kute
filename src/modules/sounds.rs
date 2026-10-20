use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

use crate::{modules::files, utils};

// goes to the page as base64 in one message
const MAX_SIZE: u64 = 10 * 1024 * 1024;
// what chromium's decodeAudioData takes with our codecs build
const EXTENSIONS: [&str; 7] = ["mp3", "ogg", "wav", "flac", "m4a", "aac", "opus"];

pub fn sounds_dir() -> PathBuf {
    utils::settings_dir().join("sounds")
}

// check the extension, byte slicing panics on names like "a🦀"
fn valid_file(name: &str) -> bool {
    let path = std::path::Path::new(name);
    files::safe_name(name)
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| EXTENSIONS.iter().any(|known| extension.eq_ignore_ascii_case(known)))
        && path.file_stem().is_some_and(|stem| !stem.is_empty())
}

pub fn list() -> Value {
    let mut names: Vec<String> = fs::read_dir(sounds_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let meta = entry.metadata().ok()?;
            (meta.is_file() && meta.len() <= MAX_SIZE && valid_file(&name)).then_some(name)
        })
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    json!(names)
}

pub fn read(name: &str) -> Result<String, String> {
    if !valid_file(name) {
        return Err(format!("{name} is no sound file"));
    }
    let path = sounds_dir().join(name);
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_SIZE {
        return Err(format!("{name} is larger than 10 MB"));
    }
    fs::read(&path).map(|bytes| STANDARD.encode(bytes)).map_err(|e| e.to_string())
}

pub fn handle_message(message: &str) -> Option<String> {
    let (command, payload) = message.split_once(' ').unwrap_or((message, "{}"));
    let payload = serde_json::from_str::<Value>(payload).ok()?;
    match command {
        "list" => Some(json!({ "sounds": list() }).to_string()),
        "get" => {
            let name = payload["name"].as_str().unwrap_or_default();
            let reply = match read(name) {
                Ok(data) => json!({ "name": name, "data": data }),
                Err(error) => json!({ "name": name, "error": error }),
            };
            Some(json!({ "sound": reply }).to_string())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_file_needs_an_audio_name() {
        assert!(valid_file("found.mp3"));
        assert!(valid_file("Found.OGG"));
        assert!(!valid_file(".mp3"));
        assert!(!valid_file("found.exe"));
        assert!(!valid_file("../found.mp3"));
        assert!(!valid_file("a🦀"));
    }
}
