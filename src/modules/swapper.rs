use std::{collections::HashMap, fs, path::PathBuf, sync::LazyLock};

use crate::utils;

/// Files the client serves in place of the game's own, keyed like the player's swapper folder.
///
/// The clouds model is 774 KB of geometry that only ever draws clouds. This client used to block the request
/// instead, and the game then built its cloud pass around a model that never arrived: every frame called
/// `useProgram` on a program that never linked, a few hundred "program not valid" lines per load on any map
/// with clouds. A valid model keeps that path whole, and one triangle a thousandth of a unit across costs
/// nothing to draw or to download.
const BUILT_IN: &[(&str, &str)] = &[("models/clouds_0.obj", include_str!("../../resources/swaps/clouds_0.obj"))];

// relative url path (forward slashes) -> file bytes, resolved once. The player's own folder is loaded over the
// built in ones, so a file of theirs always wins
pub static SWAPS: LazyLock<HashMap<String, Vec<u8>>> = LazyLock::new(|| {
    let mut swaps: HashMap<String, Vec<u8>> = BUILT_IN.iter().map(|(path, body)| ((*path).to_string(), body.as_bytes().to_vec())).collect();
    if utils::config("swapper", true) {
        swaps.extend(load());
    }
    swaps
});

// mirrors the filename extraction of the WebView2 resource handler
pub fn swap_for(url: &str) -> Option<&'static Vec<u8>> {
    if !url.contains("krunker.io") {
        return None;
    }
    let filename = url.split("krunker.io/").nth(1).and_then(|s| s.split('?').next()).unwrap_or("");
    SWAPS.get(filename)
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
