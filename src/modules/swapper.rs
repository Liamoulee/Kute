use std::{
    collections::{BTreeMap, HashMap},
    fs,
    hash::{DefaultHasher, Hash, Hasher},
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::SystemTime,
};

use crate::{
    modules::{bench, files},
    utils,
};
use serde_json::{Value, json};

const BUILT_IN: &[(&str, &str)] = &[("models/clouds_0.obj", include_str!("../../resources/swaps/clouds_0.obj"))];

type Index = HashMap<String, Arc<Vec<u8>>>;

// lowercased url path -> bytes. player files override built ins. lowercase because players name folders `CSS`
pub static SWAPS: LazyLock<RwLock<Arc<Index>>> = LazyLock::new(|| {
    let files = if utils::config("swapper", true) && !bench::active() {
        scan()
    } else {
        Vec::new()
    };
    let index = build_index(&files, &HashMap::new(), &Index::new());
    PUBLISHED.store(signature_of(&files), Ordering::Release);
    *PUBLISHED_FILES.lock().unwrap() = metadata_of(&files);
    INITIALIZED.store(true, Ordering::Release);
    RwLock::new(Arc::new(index))
});

// fingerprint (names, sizes, mtimes) of the published index, so a reload skips the read when nothing changed
static PUBLISHED: AtomicU64 = AtomicU64::new(0);
// lowercased path -> (size, mtime) of the published index: unchanged files keep their bytes, the page learns what changed
static PUBLISHED_FILES: LazyLock<Mutex<Metadata>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static INITIALIZED: AtomicBool = AtomicBool::new(false);
// held during a reload so reloads run in order
static RELOAD_LOCK: Mutex<()> = Mutex::new(());

// every krunker.io path requested this session, lowercased -> original. used by the manager
static SEEN: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
const MAX_SEEN: usize = 20_000;

// (relative path, full path, size, mtime)
type Scanned = (String, PathBuf, u64, Option<SystemTime>);
type Metadata = HashMap<String, (u64, Option<SystemTime>)>;

fn scan_folder(root: &Path, dir: &Path, out: &mut Vec<Scanned>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            scan_folder(root, &path, out);
        } else if kind.is_file() {
            let Some(relative) = path.strip_prefix(root).ok().and_then(|p| p.to_str()).map(|p| p.replace('\\', "/")) else {
                continue;
            };
            let meta = entry.metadata().ok();
            let size = meta.as_ref().map(|meta| meta.len()).unwrap_or(0);
            let modified = meta.and_then(|meta| meta.modified().ok());
            out.push((relative, path, size, modified));
        }
    }
}

// metadata only, reads no file
fn scan() -> Vec<Scanned> {
    let root = swapper_dir();
    fs::create_dir_all(&root).ok();
    let mut files = Vec::new();
    scan_folder(&root, &root, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

fn metadata_of(files: &[Scanned]) -> Metadata {
    files
        .iter()
        .map(|(relative, _, size, modified)| (relative.to_lowercase(), (*size, *modified)))
        .collect()
}

// reads only files whose size or mtime changed, a rescan after one dropped file does not reread a whole pack
fn build_index(files: &[Scanned], old_files: &Metadata, old_index: &Index) -> Index {
    let mut swaps: Index = BUILT_IN
        .iter()
        .map(|(path, body)| (path.to_lowercase(), Arc::new(body.as_bytes().to_vec())))
        .collect();
    for (relative, path, size, modified) in files {
        let key = relative.to_lowercase();
        if old_files.get(&key) == Some(&(*size, *modified))
            && let Some(bytes) = old_index.get(&key)
        {
            swaps.insert(key, bytes.clone());
            continue;
        }
        match fs::read(path) {
            Ok(bytes) => {
                swaps.insert(relative.to_lowercase(), Arc::new(bytes));
            }
            Err(e) => eprintln!("swapper: can't read {}: {}", path.display(), e),
        }
    }
    swaps
}

fn signature_of(files: &[Scanned]) -> u64 {
    let mut hasher = DefaultHasher::new();
    files.iter().for_each(|(relative, _, size, modified)| (relative, size, modified).hash(&mut hasher));
    hasher.finish()
}

// manager and watcher thread. skips the read if paths, sizes and mtimes are unchanged
pub fn reload() {
    let _guard = RELOAD_LOCK.lock().unwrap();
    reload_locked(true);
}

// ui thread, before a navigation: a file dropped into the folder has to apply on the next reload, not the next
// start. skips while the startup scan or a manager reload still runs, those publish in a moment anyway
pub fn rescan() {
    if !INITIALIZED.load(Ordering::Acquire) {
        return;
    }
    let Ok(_guard) = RELOAD_LOCK.try_lock() else { return };
    // the page is about to load its files anew, nothing to tell it
    reload_locked(false);
}

fn reload_locked(notify: bool) {
    // before PUBLISHED_FILES: the startup scan that SWAPS may still run locks it too
    let current = SWAPS.read().unwrap().clone();
    let files = if utils::config("swapper", true) { scan() } else { Vec::new() };
    let signature = signature_of(&files);
    if PUBLISHED.load(Ordering::Acquire) == signature {
        return;
    }
    let metadata = metadata_of(&files);
    let mut published = PUBLISHED_FILES.lock().unwrap();
    let index = Arc::new(build_index(&files, &published, &current));
    drop(current);
    // drop the old index outside the lock, freeing a big pack must not block requests
    let old = std::mem::replace(&mut *SWAPS.write().unwrap(), index);
    drop(old);
    PUBLISHED.store(signature, Ordering::Release);

    let mut changed: Vec<String> = metadata
        .iter()
        .filter(|(path, meta)| published.get(*path) != Some(meta))
        .map(|(path, _)| path.clone())
        .collect();
    changed.extend(published.keys().filter(|path| !metadata.contains_key(*path)).cloned());
    *published = metadata;
    drop(published);
    if notify {
        tell_page(&changed);
    }
}

// css swaps reload in place, the swapper manager lists again
#[cfg(windows)]
fn tell_page(changed: &[String]) {
    let css: Vec<&String> = changed.iter().filter(|path| path.ends_with(".css")).collect();
    crate::bridge::post_json_to_main_later(json!({ "swapperChanged": { "css": css, "count": changed.len() } }).to_string());
}

#[cfg(not(windows))]
fn tell_page(_changed: &[String]) {}

// "https://assets.krunker.io/textures/a.png?build=x" -> "textures/a.png"
pub fn swap_for(url: &str) -> Option<Arc<Vec<u8>>> {
    let path = utils::krunker_path(url)?;
    // files only, "game-list" etc are api calls
    if path.contains('.') {
        let mut seen = SEEN.lock().unwrap();
        if seen.len() < MAX_SEEN {
            seen.entry(path.to_lowercase()).or_insert_with(|| path.to_string());
        }
    }
    SWAPS.read().unwrap().get(&path.to_lowercase()).cloned()
}

pub fn has_swap(url: &str) -> bool {
    utils::krunker_path(url).is_some_and(|path| SWAPS.read().unwrap().contains_key(&path.to_lowercase()))
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

pub fn swapper_dir() -> PathBuf {
    utils::settings_dir().join("swapper")
}

// None if it points outside the swapper folder
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
    // case only renames are fine, windows says the target exists
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

// one dropped file, the index gets rebuilt by the list call after the drop
pub fn upload(relative: &str, data: &str) -> Result<(), String> {
    let path = inside(relative).filter(|path| *path != swapper_dir()).ok_or("invalid path")?;
    let bytes = files::decode_base64(data).ok_or("the file did not arrive intact")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    utils::atomic_write(&path, &bytes).map_err(|e| e.to_string())
}

// the manager's editor, text files only
const MAX_TEXT: u64 = 4 * 1024 * 1024;

pub fn read_text(relative: &str) -> Option<String> {
    let path = inside(relative).filter(|path| *path != swapper_dir())?;
    if fs::metadata(&path).ok()?.len() > MAX_TEXT {
        return None;
    }
    fs::read_to_string(path).ok()
}

pub fn write_text(relative: &str, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_TEXT {
        return Err("larger than 4 MB".into());
    }
    let path = inside(relative).filter(|path| *path != swapper_dir()).ok_or("invalid path")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    utils::atomic_write(&path, &content).map_err(|e| e.to_string())?;
    reload();
    Ok(())
}

pub fn reveal(relative: &str) {
    let root = swapper_dir();
    fs::create_dir_all(&root).ok();
    if let Some(path) = inside(relative) {
        files::reveal(if path.exists() { &path } else { &root });
    }
}
