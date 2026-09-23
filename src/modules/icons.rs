use std::{
    collections::HashMap,
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use crate::{debug_print, utils};

pub struct Slot {
    // how the page and the `kuteIconSlots` setting refer to it
    pub id: &'static str,
    pub file: &'static str,
    pub bytes: &'static [u8],
    // what the game loads here by itself, as the path after "krunker.io/" (assets.krunker.io included, the same
    // way the swapper keys its files)
    pub defaults: &'static [&'static str],
}

pub const SLOTS: &[Slot] = &[
    Slot {
        id: "kills",
        file: "kills.png",
        bytes: include_bytes!("../../server/public/kr/kills.png"),
        defaults: &["img/skull_0.png"],
    },
    Slot {
        id: "deaths",
        file: "deaths.png",
        bytes: include_bytes!("../../server/public/kr/deaths.png"),
        defaults: &["img/skull_1.png"],
    },
    Slot {
        id: "streak",
        file: "streak.png",
        bytes: include_bytes!("../../server/public/kr/streak.png"),
        defaults: &["img/skull_2.png"],
    },
    Slot {
        id: "kdr",
        file: "kdr.png",
        bytes: include_bytes!("../../server/public/kr/kdr.png"),
        defaults: &["img/skull_3.png"],
    },
    Slot {
        id: "ammo",
        file: "ammo.png",
        bytes: include_bytes!("../../server/public/kr/ammo.png"),
        defaults: &["textures/ammo_0.png"],
    },
    // the number is the hitmarker style, so every one of them is ours while the slot is on
    Slot {
        id: "hitmarker",
        file: "hitmarker.png",
        bytes: include_bytes!("../../server/public/kr/hitmarker.png"),
        defaults: &[
            "textures/hitmarker_0.png",
            "textures/hitmarker_1.png",
            "textures/hitmarker_2.png",
            "textures/hitmarker_3.png",
            "textures/hitmarker_4.png",
            "textures/hitmarker_5.png",
            "textures/hitmarker_6.png",
        ],
    },
    Slot {
        id: "reticle",
        file: "reticle.png",
        bytes: include_bytes!("../../server/public/kr/reticle.png"),
        defaults: &[
            "textures/reticles/reticle_0.png",
            "textures/reticles/reticle_1.png",
            "textures/reticles/reticle_2.png",
            "textures/reticles/reticle_3.png",
        ],
    },
    // krunker's own spelling
    Slot {
        id: "scope",
        file: "scope.png",
        bytes: include_bytes!("../../server/public/kr/scope.png"),
        defaults: &["textures/recticle.png"],
    },
];

// Where our files are served whatever the toggle says, for the previews in the customizer. Same origin as the
// page, so they show with kute.lol unreachable too.
const PREVIEW_PATH: &str = "kute-icons/";

// The setting holding the player's own URLs, so they survive a restart.
const URLS_SETTING: &str = "kuteIconUrls";

// Every default path, so a request that is none of ours costs one hash lookup. This runs for every request the
// page makes.
static DEFAULT_PATHS: LazyLock<HashMap<&'static str, &'static Slot>> =
    LazyLock::new(|| SLOTS.iter().flat_map(|slot| slot.defaults.iter().map(move |path| (*path, slot))).collect());

// The player's own URLs (without the query) -> slot id.
static PLAYER_URLS: LazyLock<Mutex<HashMap<String, &'static str>>> = LazyLock::new(|| {
    let saved: serde_json::Value = utils::config(URLS_SETTING, serde_json::Value::Null);
    let urls = parse_urls(&saved);
    PLAYER_URL_COUNT.store(urls.len(), Ordering::Relaxed);
    Mutex::new(urls)
});
// How many there are, so a player who set no image of their own never takes the lock.
static PLAYER_URL_COUNT: AtomicUsize = AtomicUsize::new(usize::MAX);

// A URL of the player's without its query, the way requests are compared. Empty for what can never be one.
fn clean_url(url: &str) -> &str {
    let url = url.split(['?', '#']).next().unwrap_or(url).trim();
    if url.starts_with("http") { url } else { "" }
}

// `{"kills": ["https://..."], ...}` -> url -> slot id. Unknown slots and anything that is not a URL are dropped.
fn parse_urls(json: &serde_json::Value) -> HashMap<String, &'static str> {
    let mut urls = HashMap::new();
    let Some(object) = json.as_object() else { return urls };
    for slot in SLOTS {
        for value in object.get(slot.id).and_then(serde_json::Value::as_array).map(Vec::as_slice).unwrap_or_default() {
            let url = value.as_str().map(clean_url).unwrap_or_default();
            if !url.is_empty() {
                urls.insert(url.to_string(), slot.id);
            }
        }
    }
    urls
}

// `icon-urls <json>` from the page: sent at every page load and whenever one of those URLs changes.
pub fn set_player_urls(json: &serde_json::Value) {
    let urls = parse_urls(json);
    let mut current = PLAYER_URLS.lock().unwrap();
    if *current == urls {
        return;
    }
    debug_print!("icons: {} player urls", urls.len());
    PLAYER_URL_COUNT.store(urls.len(), Ordering::Relaxed);
    // saved in the same shape, but only what survived the parse
    let mut saved = serde_json::Map::new();
    for (url, id) in &urls {
        let list = saved.entry(*id).or_insert_with(|| serde_json::Value::Array(Vec::new()));
        if let Some(list) = list.as_array_mut() {
            list.push(serde_json::Value::from(url.as_str()));
        }
    }
    *current = urls;
    drop(current);

    crate::CONFIG.lock().unwrap().set(URLS_SETTING, saved);
    crate::config::save_soon();
}

// Whether this slot is switched on. Every slot is on until the player unticks it in the customizer.
fn slot_on(id: &str) -> bool {
    let chosen: serde_json::Value = utils::config("kuteIconSlots", serde_json::Value::Null);
    chosen.get(id).and_then(serde_json::Value::as_bool).unwrap_or(true)
}

fn slot_by_id(id: &str) -> Option<&'static Slot> {
    SLOTS.iter().find(|slot| slot.id == id)
}

// The file to answer this request with, or None to leave it alone.
pub fn bytes_for(url: &str) -> Option<&'static [u8]> {
    let path = utils::krunker_path(url);

    if let Some(file) = path.and_then(|path| path.strip_prefix(PREVIEW_PATH)) {
        return SLOTS.iter().find(|slot| slot.file == file).map(|slot| slot.bytes);
    }

    // settings are only read once a request really is one of ours, a handful out of everything a page loads
    let slot = match path.and_then(|path| DEFAULT_PATHS.get(path)) {
        Some(slot) => *slot,
        None => {
            // usize::MAX until the saved URLs are read, which the first request of this kind does
            if PLAYER_URL_COUNT.load(Ordering::Relaxed) == 0 {
                return None;
            }
            let id = *PLAYER_URLS.lock().unwrap().get(clean_url(url))?;
            slot_by_id(id)?
        }
    };

    if !utils::config("kuteIcons", false) || !slot_on(slot.id) {
        return None;
    }
    Some(slot.bytes)
}
