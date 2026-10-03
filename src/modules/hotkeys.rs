use crate::utils;
use serde::Deserialize;
use std::{
    sync::{LazyLock, Mutex, RwLock},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    NewLobby,
    Matchmaker,
    Reload,
    Fullscreen,
    DevTools,
}

// ids and defaults must match DEFAULT_HOTKEYS in frontend/modules/hotkeys.js
const ACTIONS: [(Action, &str, u16); 5] = [
    (Action::NewLobby, "newLobby", 0x73),
    (Action::Matchmaker, "matchmaker", 0x75),
    (Action::Reload, "reload", 0x74),
    (Action::Fullscreen, "fullscreen", 0x7A),
    (Action::DevTools, "devtools", 0x7B),
];

// cef_event_flags_t
const SHIFT: u32 = 2;
const CONTROL: u32 = 4;
const ALT: u32 = 8;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
struct Binding {
    key: u16,
    #[serde(default)]
    ctrl: bool,
    #[serde(default)]
    alt: bool,
    #[serde(default)]
    shift: bool,
}

// read on every key press, so parsed once and replaced when the page saves new bindings
static BINDINGS: LazyLock<RwLock<Vec<(Action, Binding)>>> = LazyLock::new(|| RwLock::new(load()));

// missing action: its default. null: cleared by the player
fn load() -> Vec<(Action, Binding)> {
    let stored = utils::config("hotkeys", serde_json::Map::new());
    ACTIONS
        .iter()
        .filter_map(|&(action, id, default)| {
            let binding = match stored.get(id) {
                None => Binding {
                    key: default,
                    ctrl: false,
                    alt: false,
                    shift: false,
                },
                Some(value) => serde_json::from_value::<Binding>(value.clone()).ok()?,
            };
            (binding.key != 0).then_some((action, binding))
        })
        .collect()
}

pub fn reload() {
    *BINDINGS.write().unwrap() = load();
}

// the hotkey menu waits for a key, F5 must reach it instead of reloading. capped so a page that dies meanwhile can't leave them off
static PAUSED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
const PAUSE_LIMIT: Duration = Duration::from_secs(15);

pub fn pause(on: bool) {
    *PAUSED_UNTIL.lock().unwrap() = on.then(|| Instant::now() + PAUSE_LIMIT);
}

pub fn action_for(key_code: i32, modifiers: u32) -> Option<Action> {
    if PAUSED_UNTIL.lock().unwrap().is_some_and(|until| Instant::now() < until) {
        return None;
    }
    let pressed = Binding {
        key: u16::try_from(key_code).ok()?,
        ctrl: modifiers & CONTROL != 0,
        alt: modifiers & ALT != 0,
        shift: modifiers & SHIFT != 0,
    };
    BINDINGS.read().unwrap().iter().find(|(_, binding)| *binding == pressed).map(|(action, _)| *action)
}
