use serde_json::{Map, Value, json};
use std::{fs, io::Read, path::PathBuf};

use crate::{modules::files, utils};

pub const RUNNER: &str = include_str!("../frontend/host/userscriptRunner.js");

// id, subfolder of scripts/, shown name, where it runs
pub const GROUPS: [(&str, &str, &str, &str); 2] = [
    ("game", "", "Game", "krunker.io in the main window"),
    ("social", "social", "Social", "social / hub popups"),
];

const MAX_SOURCE: usize = 4 * 1024 * 1024;
// the manager's list only needs the header, which sits at the top: this much of each file is read for it
const HEADER_READ: u64 = 64 * 1024;

pub struct Script {
    pub key: String,
    pub group: &'static str,
    pub file: String,
    pub enabled: bool,
    pub run_at_start: bool,
    pub priority: i64,
    pub meta: Map<String, Value>,
    pub prefs: Value,
    // the whole file for the renderer, only the first HEADER_READ bytes for the manager's list
    pub source: String,
    pub size: u64,
}

impl Script {
    // what the runner and the manager get, without the source
    pub fn describe(&self) -> Value {
        json!({
            "key": self.key,
            "group": self.group,
            "file": self.file,
            "enabled": self.enabled,
            "runAt": if self.run_at_start { "document-start" } else { "document-end" },
            "priority": self.priority,
            "meta": self.meta,
            "prefs": self.prefs,
        })
    }
}

pub fn scripts_dir() -> PathBuf {
    utils::settings_dir().join("scripts")
}

fn group_by_id(id: &str) -> Option<&'static (&'static str, &'static str, &'static str, &'static str)> {
    GROUPS.iter().find(|group| group.0 == id)
}

fn group_dir(id: &str) -> Option<PathBuf> {
    let (_, sub, _, _) = group_by_id(id)?;
    Some(if sub.is_empty() { scripts_dir() } else { scripts_dir().join(sub) })
}

fn key_for(group: &str, file: &str) -> String {
    match group_by_id(group) {
        Some((_, sub, _, _)) if !sub.is_empty() => format!("{sub}/{file}"),
        _ => file.to_string(),
    }
}

// "social/x.js" -> ("social", "x.js"), "x.js" -> ("game", "x.js"). Only names a script can have
fn split_key(key: &str) -> Option<(&'static str, String)> {
    let (group, file) = match key.split_once('/') {
        Some((sub, file)) => (GROUPS.iter().find(|group| !group.1.is_empty() && group.1 == sub)?.0, file),
        None => ("game", key),
    };
    valid_file(file).then(|| (group, file.to_string()))
}

// a name with something in front of ".js". Checked on the extension, never by slicing bytes: a folder can hold
// any file, and a byte index into "a🦀" lands inside the crab and panics
fn valid_file(file: &str) -> bool {
    let path = std::path::Path::new(file);
    files::safe_name(file)
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("js"))
        && path.file_stem().is_some_and(|stem| !stem.is_empty())
}

fn path_for(key: &str) -> Option<PathBuf> {
    let (group, file) = split_key(key)?;
    Some(group_dir(group)?.join(file))
}

fn read_json(path: &PathBuf) -> Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| if let Value::Object(map) = value { Some(map) } else { None })
        .unwrap_or_default()
}

fn write_json(path: &PathBuf, map: &Map<String, Value>) {
    fs::create_dir_all(scripts_dir()).ok();
    if let Ok(text) = serde_json::to_string_pretty(map) {
        utils::atomic_write(path, &text).ok();
    }
}

fn tracker_path() -> PathBuf {
    scripts_dir().join("tracker.json")
}

fn prefs_path() -> PathBuf {
    scripts_dir().join("prefs.json")
}

// `// ==UserScript==` block
fn parse_metadata(source: &str) -> Option<Map<String, Value>> {
    let mut meta = Map::new();
    let mut inside = false;
    for line in source.lines() {
        let line = line.trim();
        if !inside {
            if line.starts_with("//") && line.contains("==UserScript==") {
                inside = true;
            }
            continue;
        }
        if line.starts_with("//") && line.contains("==/UserScript==") {
            return Some(meta);
        }
        let Some(rest) = line.strip_prefix("//").map(str::trim).and_then(|rest| rest.strip_prefix('@')) else {
            continue;
        };
        let (key, value) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
        let key = match key {
            "description" => "desc",
            "name" | "author" | "version" | "desc" | "src" | "license" | "run-at" | "priority" => key,
            _ => continue,
        };
        let value: String = value.trim().chars().take(300).collect();
        meta.insert(key.to_string(), Value::String(value));
    }
    None
}

fn load_script(group: &'static str, file: String, tracker: &Map<String, Value>, prefs: &Map<String, Value>, whole: bool) -> Option<Script> {
    let path = group_dir(group)?.join(&file);
    let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if size > MAX_SOURCE as u64 {
        return None;
    }
    let read = if whole {
        fs::read_to_string(&path)
    } else {
        // a cut in the middle of a character only costs that character, the header is long done by then
        fs::File::open(&path).and_then(|file| {
            let mut bytes = Vec::new();
            file.take(HEADER_READ).read_to_end(&mut bytes)?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        })
    };
    let source = match read {
        Ok(source) => source,
        Err(e) => {
            eprintln!("userscripts: can't read {}: {}", path.display(), e);
            return None;
        }
    };
    let key = key_for(group, &file);
    let header = parse_metadata(&source);
    // no header: the old glorp behavior, straight away. With one: Crankshaft's default, after the document
    let run_at_start = match header.as_ref().and_then(|meta| meta.get("run-at")).and_then(Value::as_str) {
        Some(run_at) => run_at == "document-start" || run_at == "document.start",
        None => header.is_none(),
    };
    let mut meta = header.unwrap_or_default();
    let priority = meta
        .remove("priority")
        .and_then(|value| value.as_str().and_then(|text| text.trim().parse().ok()))
        .unwrap_or(0);
    meta.remove("run-at");
    Some(Script {
        enabled: tracker.get(&key).and_then(Value::as_bool).unwrap_or(true),
        prefs: prefs.get(&key).cloned().unwrap_or_else(|| json!({})),
        key,
        group,
        file,
        run_at_start,
        priority,
        meta,
        source,
        size,
    })
}

// Every script of a group, sorted by file name (the runner orders by priority).
pub fn load_group(group: &str) -> Vec<Script> {
    load_group_from(group, true)
}

fn load_group_from(group: &str, whole: bool) -> Vec<Script> {
    let Some(&(id, ..)) = group_by_id(group) else { return Vec::new() };
    let Some(dir) = group_dir(id) else { return Vec::new() };
    let tracker = read_json(&tracker_path());
    let prefs = read_json(&prefs_path());
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
                .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
                .filter(|name| valid_file(name))
                .collect()
        })
        .unwrap_or_default();
    names.sort_by_key(|name| name.to_lowercase());
    names.into_iter().filter_map(|file| load_script(id, file, &tracker, &prefs, whole)).collect()
}

// The list for the manager: every group with its scripts (no sources). Also drops tracker and prefs entries of
// files that are gone.
pub fn list() -> Value {
    fs::create_dir_all(scripts_dir().join("social")).ok();
    let mut keys = Vec::new();
    let groups: Vec<Value> = GROUPS
        .iter()
        .map(|(id, _, label, runs)| {
            let scripts: Vec<Value> = load_group_from(id, false)
                .iter()
                .map(|script| {
                    keys.push(script.key.clone());
                    let mut value = script.describe();
                    value["size"] = json!(script.size);
                    value.as_object_mut().map(|object| object.remove("prefs"));
                    value
                })
                .collect();
            json!({ "id": id, "label": label, "runs": runs, "scripts": scripts })
        })
        .collect();

    for path in [tracker_path(), prefs_path()] {
        let mut map = read_json(&path);
        let before = map.len();
        map.retain(|key, _| keys.contains(key));
        if map.len() != before {
            write_json(&path, &map);
        }
    }
    json!({ "groups": groups, "folder": scripts_dir().display().to_string() })
}

pub fn read(key: &str) -> Option<String> {
    fs::read_to_string(path_for(key)?).ok()
}

pub fn write(group: &str, file: &str, content: &str) -> Result<(), String> {
    if content.len() > MAX_SOURCE {
        return Err("The script is larger than 4 MB".into());
    }
    if !valid_file(file) {
        return Err("Script names end in .js and cannot contain \\ / : * ? \" < > |".into());
    }
    let dir = group_dir(group).ok_or("Unknown group")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    utils::atomic_write(&dir.join(file), &content).map_err(|e| e.to_string())
}

pub fn set_enabled(key: &str, enabled: bool) {
    if split_key(key).is_none() {
        return;
    }
    let mut tracker = read_json(&tracker_path());
    tracker.insert(key.to_string(), Value::Bool(enabled));
    write_json(&tracker_path(), &tracker);
}

pub fn set_prefs(key: &str, prefs: Value) {
    if split_key(key).is_none() || !prefs.is_object() {
        return;
    }
    let mut map = read_json(&prefs_path());
    map.insert(key.to_string(), prefs);
    write_json(&prefs_path(), &map);
}

pub fn delete(key: &str) -> Result<(), String> {
    let path = path_for(key).ok_or("Unknown script")?;
    files::recycle(&path).map_err(|e| e.to_string())
}

// moves a script into another group, keeping its tracker and prefs entries
pub fn move_to(key: &str, group: &str) -> Result<(), String> {
    let (_, file) = split_key(key).ok_or("Unknown script")?;
    let from = path_for(key).ok_or("Unknown script")?;
    let dir = group_dir(group).ok_or("Unknown group")?;
    let to = dir.join(&file);
    if to.exists() {
        return Err(format!("{file} already exists there"));
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::rename(&from, &to).map_err(|e| e.to_string())?;
    let new_key = key_for(group, &file);
    for path in [tracker_path(), prefs_path()] {
        let mut map = read_json(&path);
        if let Some(value) = map.remove(key) {
            map.insert(new_key.clone(), value);
            write_json(&path, &map);
        }
    }
    Ok(())
}

pub fn reveal(key: Option<&str>) {
    match key {
        Some(key) => {
            if let Some(path) = path_for(key) {
                files::reveal(&path);
            }
        }
        None => {
            fs::create_dir_all(scripts_dir().join("social")).ok();
            files::reveal(&scripts_dir());
        }
    }
}

// One self-contained document script per enabled social script: the runner plus that script, so a syntax error
// only costs that one.
pub fn social_document_scripts() -> Vec<String> {
    let mut scripts = load_group("social");
    // document scripts run in the order they were added, so the priority order is decided here
    scripts.sort_by_key(|script| std::cmp::Reverse(script.priority));
    scripts
        .into_iter()
        .filter(|script| script.enabled)
        .map(|script| {
            format!(
                "(function () {{\n{RUNNER}\nconst script = {};\nscript.run = function (module, exports) {{{}\n}};\nrunUserscripts([script], null);\n}})();",
                script.describe(),
                script.source
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::valid_file;

    #[test]
    fn valid_file_never_slices_inside_a_character() {
        assert!(valid_file("ok.js"));
        assert!(valid_file("OK.JS"));
        assert!(valid_file("skript-🦀.js"));
        assert!(!valid_file("readme.txt"));
        // these used to panic: a byte index three from the end lands inside the last character
        assert!(!valid_file("a🦀"));
        assert!(!valid_file("🦀"));
        assert!(!valid_file("ü"));
        assert!(!valid_file(".js"));
        assert!(!valid_file("js"));
        assert!(!valid_file(""));
        assert!(!valid_file("a.js.txt"));
    }
}
