use serde_json::{Value, json};
use std::{fs, path::PathBuf};

use crate::{modules::files, utils};

// themes embed fonts as base64 data urls
const MAX_SIZE: usize = 4 * 1024 * 1024;
// first name a migrated or legacy save gets
const DEFAULT_FILE: &str = "custom.css";

pub fn css_dir() -> PathBuf {
    utils::settings_dir().join("css")
}

// single file before the css manager
fn legacy_path() -> PathBuf {
    utils::settings_dir().join("custom.css")
}

fn state_path() -> PathBuf {
    css_dir().join("active.json")
}

// check the extension, byte slicing panics on names like "a🦀"
fn valid_file(name: &str) -> bool {
    let path = std::path::Path::new(name);
    files::safe_name(name)
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("css"))
        && path.file_stem().is_some_and(|stem| !stem.is_empty())
}

fn path_for(name: &str) -> Option<PathBuf> {
    valid_file(name).then(|| css_dir().join(name))
}

fn legacy_modified() -> Option<u64> {
    let modified = fs::metadata(legacy_path()).ok()?.modified().ok()?;
    modified.duration_since(std::time::UNIX_EPOCH).ok().map(|age| age.as_millis() as u64)
}

fn read_state() -> Option<Value> {
    serde_json::from_str::<Value>(&fs::read_to_string(state_path()).ok()?).ok()
}

fn write_state(active: Option<&str>, legacy: Option<u64>) -> Result<(), String> {
    fs::create_dir_all(css_dir()).map_err(|e| e.to_string())?;
    utils::atomic_write(&state_path(), &json!({ "active": active, "legacy": legacy }).to_string()).map_err(|e| e.to_string())
}

// browser process, before cef starts. copied, not moved: an older exe still reads custom.css, and what
// it saved there after the first copy comes in again as a new file
pub fn migrate() {
    let Some(modified) = legacy_modified() else { return };
    let state = read_state();
    let taken = state.as_ref().map(|state| state["legacy"].as_u64());
    let name = match taken {
        None => DEFAULT_FILE.to_string(),
        // a state from before this check, its copy is the current one
        Some(None) => {
            write_state(active().as_deref(), Some(modified)).ok();
            return;
        }
        Some(Some(taken)) if modified <= taken => return,
        Some(Some(_)) => free_name(DEFAULT_FILE),
    };
    let target = css_dir().join(&name);
    let copied = fs::create_dir_all(css_dir()).and_then(|_| if target.exists() { Ok(0) } else { fs::copy(legacy_path(), &target) });
    match copied {
        Ok(_) => {
            write_state(Some(&name), Some(modified)).ok();
        }
        Err(e) => eprintln!("custom css: can't copy {} into {}: {}", legacy_path().display(), css_dir().display(), e),
    }
}

pub fn active() -> Option<String> {
    let name = read_state()?["active"].as_str()?.to_string();
    path_for(&name)?.is_file().then_some(name)
}

// empty name = none
pub fn set_active(name: &str) -> Result<(), String> {
    if !name.is_empty() && !path_for(name).is_some_and(|path| path.is_file()) {
        return Err(format!("{name} does not exist"));
    }
    let legacy = read_state().and_then(|state| state["legacy"].as_u64()).or_else(legacy_modified);
    write_state((!name.is_empty()).then_some(name), legacy)
}

pub fn list() -> Value {
    let mut found: Vec<(String, u64)> = fs::read_dir(css_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let meta = entry.metadata().ok()?;
            (meta.is_file() && valid_file(&name)).then_some((name, meta.len()))
        })
        .collect();
    found.sort_by_key(|(name, _)| name.to_lowercase());
    let files: Vec<Value> = found.into_iter().map(|(name, size)| json!({ "name": name, "size": size })).collect();
    json!({ "files": files, "active": active() })
}

pub fn read_file(name: &str) -> Option<String> {
    fs::read_to_string(path_for(name)?).ok()
}

pub fn write_file(name: &str, content: &str) -> Result<(), String> {
    if content.len() > MAX_SIZE {
        return Err(format!("{name} is larger than 4 MB"));
    }
    let path = path_for(name).ok_or("CSS file names end in .css and cannot contain \\ / : * ? \" < > |")?;
    fs::create_dir_all(css_dir()).map_err(|e| e.to_string())?;
    utils::atomic_write(&path, &content).map_err(|e| e.to_string())
}

// "theme.css" -> "theme (2).css" while taken
pub fn free_name(name: &str) -> String {
    if !path_for(name).is_some_and(|path| path.exists()) {
        return name.to_string();
    }
    let stem = &name[..name.len() - ".css".len()];
    (2..1000)
        .map(|n| format!("{stem} ({n}).css"))
        .find(|candidate| !css_dir().join(candidate).exists())
        .unwrap_or_else(|| name.to_string())
}

pub fn rename(from: &str, to: &str) -> Result<(), String> {
    let source = path_for(from).ok_or("Unknown CSS file")?;
    let target = path_for(to).ok_or("CSS file names end in .css and cannot contain \\ / : * ? \" < > |")?;
    // a case-only rename is the same file on windows, two files on linux
    if target.exists() && !(cfg!(windows) && from.eq_ignore_ascii_case(to)) {
        return Err(format!("{to} already exists"));
    }
    let was_active = active().as_deref() == Some(from);
    fs::rename(source, target).map_err(|e| e.to_string())?;
    if was_active { set_active(to) } else { Ok(()) }
}

pub fn delete(name: &str) -> Result<(), String> {
    let path = path_for(name).ok_or("Unknown CSS file")?;
    let was_active = active().as_deref() == Some(name);
    files::recycle(&path).map_err(|e| e.to_string())?;
    if was_active { set_active("") } else { Ok(()) }
}

// the active file, what pages get
pub fn read() -> String {
    active().and_then(|name| read_file(&name)).unwrap_or_default()
}

// bundles before the css manager edit one file: the active one, or a new custom.css that becomes active
pub fn write(content: &str) -> Result<(), String> {
    match active() {
        Some(name) => write_file(&name, content),
        None => {
            let name = free_name(DEFAULT_FILE);
            write_file(&name, content)?;
            set_active(&name)
        }
    }
}

// renderer only
pub fn enabled_on_disk() -> bool {
    utils::config_on_disk("customCss", true)
}

pub fn for_page() -> String {
    if !enabled_on_disk() {
        return String::new();
    }
    let css = read();
    if css.len() > MAX_SIZE { String::new() } else { css }
}

pub fn reveal(name: Option<&str>) {
    let dir = css_dir();
    fs::create_dir_all(&dir).ok();
    match name.and_then(path_for).filter(|path| path.exists()) {
        Some(path) => files::reveal(&path),
        None => files::reveal(&dir),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_file_needs_a_css_name() {
        assert!(valid_file("theme.css"));
        assert!(valid_file("Theme.CSS"));
        assert!(!valid_file(".css"));
        assert!(!valid_file("theme.js"));
        assert!(!valid_file("../theme.css"));
        assert!(!valid_file("a🦀"));
    }
}
