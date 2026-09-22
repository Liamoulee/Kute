use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex, RwLock},
};

use crate::{modules::files, utils};
use serde_json::{Value, json};

/// Files the client serves in place of the game's own, keyed like the player's swapper folder.
///
/// The clouds model is 774 KB of geometry that only ever draws clouds. This client used to block the request
/// instead, and the game then built its cloud pass around a model that never arrived: every frame called
/// `useProgram` on a program that never linked, a few hundred "program not valid" lines per load on any map
/// with clouds. A valid model keeps that path whole, and one triangle a thousandth of a unit across costs
/// nothing to draw or to download.
const BUILT_IN: &[(&str, &str)] = &[("models/clouds_0.obj", include_str!("../../resources/swaps/clouds_0.obj"))];

type Index = HashMap<String, Arc<Vec<u8>>>;

// lowercased relative url path (forward slashes) -> file bytes. The player's own folder is loaded over the built
// in ones, so a file of theirs always wins. Lowercase because players name folders `CSS` or `Textures` and the
// game asks for `css` and `textures`, which used to fail without a word
pub static SWAPS: LazyLock<RwLock<Arc<Index>>> = LazyLock::new(|| RwLock::new(Arc::new(build_index())));

// every krunker.io file the game asked for this session, lowercased -> as requested. The swapper manager marks
// swaps the game never asked for with it, and offers these paths as drop targets
static SEEN: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
const MAX_SEEN: usize = 20_000;

fn build_index() -> Index {
    let mut swaps: Index = BUILT_IN
        .iter()
        .map(|(path, body)| (path.to_lowercase(), Arc::new(body.as_bytes().to_vec())))
        .collect();
    if utils::config("swapper", true) {
        for (path, bytes) in load() {
            swaps.insert(path.to_lowercase(), Arc::new(bytes));
        }
    }
    swaps
}

// reads the folder again after the manager changed it, off the UI thread. The next request sees the new files
pub fn reload() {
    std::thread::spawn(|| {
        let index = Arc::new(build_index());
        *SWAPS.write().unwrap() = index;
    });
}

// "https://assets.krunker.io/textures/a.png?build=x" -> "textures/a.png"
fn relative_path(url: &str) -> Option<&str> {
    if !url.contains("krunker.io") {
        return None;
    }
    url.split("krunker.io/").nth(1).and_then(|s| s.split(['?', '#']).next())
}

pub fn swap_for(url: &str) -> Option<Arc<Vec<u8>>> {
    let path = relative_path(url)?;
    // only files: "game-list" and friends are api calls
    if path.contains('.') {
        let mut seen = SEEN.lock().unwrap();
        if seen.len() < MAX_SEEN {
            seen.entry(path.to_lowercase()).or_insert_with(|| path.to_string());
        }
    }
    SWAPS.read().unwrap().get(&path.to_lowercase()).cloned()
}

pub fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "obj" | "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn recurse_swap(root_dir: &PathBuf, swap_dir: PathBuf, swaps: &mut HashMap<String, Vec<u8>>) {
    let Ok(entries) = fs::read_dir(&swap_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            recurse_swap(root_dir, path, swaps);
        } else if file_type.is_file() {
            let Some(relative_path) = path.strip_prefix(root_dir).ok().and_then(|p| p.to_str()).map(|p| p.replace('\\', "/")) else {
                continue;
            };
            match fs::read(&path) {
                Ok(content) => {
                    swaps.insert(relative_path, content);
                }
                Err(e) => eprintln!("swapper: can't read {}: {}", path.display(), e),
            }
        }
    }
}

pub fn load() -> HashMap<String, Vec<u8>> {
    let swap_dir = utils::settings_dir().join("swapper");
    fs::create_dir_all(&swap_dir).unwrap_or_default();
    let mut swaps = HashMap::new();
    recurse_swap(&swap_dir, swap_dir.clone(), &mut swaps);
    swaps
}

pub fn swapper_dir() -> PathBuf {
    utils::settings_dir().join("swapper")
}

// a path inside the swapper folder, or None when the page named something outside of it
fn inside(relative: &str) -> Option<PathBuf> {
    Some(swapper_dir().join(files::safe_relative(relative)?))
}

fn list_folder(root: &PathBuf, dir: &PathBuf, files_out: &mut Vec<Value>, dirs_out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(relative) = path.strip_prefix(root).ok().map(files::to_slashes) else {
            continue;
        };
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => {
                dirs_out.push(relative);
                list_folder(root, &path, files_out, dirs_out);
            }
            Ok(kind) if kind.is_file() => {
                let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                files_out.push(json!({ "path": relative, "size": size }));
            }
            _ => {}
        }
    }
}

/// What the manager shows: the folder's files and folders, and what the game requested this session.
pub fn list() -> Value {
    let root = swapper_dir();
    fs::create_dir_all(&root).ok();
    let mut files_out = Vec::new();
    let mut dirs_out = Vec::new();
    list_folder(&root, &root, &mut files_out, &mut dirs_out);
    let seen: Vec<String> = SEEN.lock().unwrap().values().cloned().collect();
    json!({ "files": files_out, "dirs": dirs_out, "seen": seen, "folder": root.display().to_string(), "enabled": utils::config("swapper", true) })
}

pub fn make_dir(relative: &str) -> Result<(), String> {
    let path = inside(relative).ok_or("Invalid folder name")?;
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

pub fn delete(relative: &str) -> Result<(), String> {
    let path = inside(relative).filter(|path| *path != swapper_dir()).ok_or("Invalid path")?;
    files::recycle(&path).map_err(|e| e.to_string())?;
    reload();
    Ok(())
}

pub fn move_to(from: &str, to: &str) -> Result<(), String> {
    let source = inside(from).filter(|path| *path != swapper_dir()).ok_or("Invalid path")?;
    let target = inside(to).filter(|path| *path != swapper_dir()).ok_or("Invalid target path")?;
    if target.starts_with(&source) {
        return Err("A folder cannot move into itself".into());
    }
    // a rename that only changes the case is allowed, the old file "exists" under the new name on Windows
    if target.exists() && from.to_lowercase() != to.to_lowercase() {
        return Err(format!("{to} already exists"));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&source, &target).map_err(|e| e.to_string())?;
    reload();
    Ok(())
}

/// Saves one dropped file (base64) at `relative`, creating its folders. The index is rebuilt by the list the
/// page asks for once all files of a drop are through.
pub fn upload(relative: &str, data: &str) -> Result<(), String> {
    let path = inside(relative).filter(|path| *path != swapper_dir()).ok_or("invalid path")?;
    let bytes = files::decode_base64(data).ok_or("the file did not arrive intact")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    utils::atomic_write(&path, &bytes).map_err(|e| e.to_string())
}

pub fn reveal(relative: &str) {
    let root = swapper_dir();
    fs::create_dir_all(&root).ok();
    if let Some(path) = inside(relative) {
        files::reveal(if path.exists() { &path } else { &root });
    }
}
