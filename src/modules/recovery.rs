use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    app, config, debug_print,
    modules::{
        bisect::{Ddmin, Verdict},
        eventlog, flaglist, swapper, userscripts,
    },
    utils,
};

// safe mode and the crash bisect. design: _docs/recovery-and-diagnostics-plan.md. nothing here runs while the player
// plays: a marker at start, one write per milestone, one at exit

pub const SAFE_ARG: &str = "--safe-mode";
// every subprocess inherits it, so renderer and gpu process apply the same session overrides
pub const ENV: &str = "KUTE_RECOVERY";
const BAD_STREAK_ASK: u32 = 2;
const MAX_OUTCOMES: usize = 20;
// a crash's time from start, times this, without a crash counts as "ran fine"
const SURVIVE_FACTOR: u64 = 3;
// when no crash time is known yet
const FALLBACK_STARTUP_MS: u64 = 60_000;
const FALLBACK_PLAY_MS: u64 = 15 * 60_000;
// crashes this soon after start get tested by kute alone, later ones need the player to play
const STARTUP_WINDOW_MS: u64 = 60_000;
// a session that ran this long after the game loaded is good enough to remember, a match counts right away
const KNOWN_GOOD_MS: u64 = 10 * 60_000;

// switched back to their defaults in safe mode, next to userscripts, swaps, custom css and the hook going off
const SAFE_DEFAULTS: [&str; 18] = [
    "uncapFps",
    "audioFix",
    "angleBackend",
    "colorProfile",
    "displayServer",
    "primeOffload",
    "webviewPriority",
    "x3dCacheCores",
    "renderStats",
    "realPing",
    "discordRPC",
    "patchInputPriority",
    "patchFramePacing",
    "patchFrameLimiter",
    "patchRawInputMovement",
    "patchAudioParamCoalesce",
    "patchCanvasBufferCache",
    "patchHighQoS",
];
const SAFE_OFF: [&str; 5] = ["userscripts", "swapper", "customCss", "hardFlip", "laptopPowerBoost"];

/// session only, never saved
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Overrides {
    #[serde(default)]
    pub settings: Map<String, Value>,
    #[serde(default)]
    pub scripts_off: Vec<String>,
    #[serde(default)]
    pub user_flags_off: Vec<String>,
    #[serde(default)]
    pub no_user_flags: bool,
    #[serde(default)]
    pub no_user_blocklist: bool,
    #[serde(default)]
    pub embedded_bundle: bool,
}

static OVERRIDES: LazyLock<RwLock<Arc<Overrides>>> = LazyLock::new(|| {
    let parsed = std::env::var(ENV).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    RwLock::new(Arc::new(parsed))
});

pub fn overrides() -> Arc<Overrides> {
    OVERRIDES.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

pub fn setting(key: &str) -> Option<Value> {
    let overrides = OVERRIDES.read().unwrap_or_else(|poisoned| poisoned.into_inner());
    if overrides.settings.is_empty() {
        None
    } else {
        overrides.settings.get(key).cloned()
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
enum Ended {
    Clean,
    Crashed,
    Renderer,
    // ended without a word before the game loaded
    Early,
    // ended without a word after it loaded: a crash, a kill or a pc shutdown, can't tell
    Unknown,
}

impl Ended {
    fn bad(self) -> bool {
        matches!(self, Ended::Crashed | Ended::Renderer | Ended::Early)
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
enum Mode {
    #[default]
    Normal,
    Safe,
    Probe,
    // the start after a verdict: the culprit stays off until the player decides, a startup crash would hide the result
    Result,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
struct Session {
    started: u64,
    milestone: String,
    renderer_crashes: u32,
    crashed: Option<String>,
    uptime_ms: Option<u64>,
    mode: Mode,
    // the items this probe kept as the player has them
    probe: Option<Vec<usize>>,
    survived: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    ended: Ended,
    milestone: String,
    uptime_ms: Option<u64>,
    mode: Mode,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct History {
    outcomes: Vec<Outcome>,
    bad_streak: u32,
}

/// what a working setup looked like, compared against when the next crashes come
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    kute: String,
    settings: Map<String, Value>,
    // enabled scripts only, key -> crc32
    scripts: BTreeMap<String, String>,
    user_flags: Vec<String>,
    blocklist: String,
    swaps: String,
    custom_css: String,
    bundle: String,
}

/// one thing a test can switch back
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Item {
    Setting { key: String, value: Value },
    Script { key: String },
    UserFlag { flag: String },
    UserBlocklist,
    Swaps,
    CustomCss,
    DownloadedBundle,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
enum Kind {
    // crashes before the game loads, kute runs the tests by itself
    Startup,
    // crashes while playing, every session is one test
    Play,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct TestRecord {
    active: Vec<usize>,
    crashed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Bisect {
    kind: Kind,
    items: Vec<Item>,
    search: Ddmin,
    tests: Vec<TestRecord>,
    threshold_ms: u64,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
// streak of bad sessions when no dialog could ask (linux, no comctl v6), the page offers it then
static OFFER: Mutex<bool> = Mutex::new(false);

fn dir() -> PathBuf {
    utils::settings_dir().join("recovery")
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0)
}

fn read<T: serde::de::DeserializeOwned>(name: &str) -> Option<T> {
    serde_json::from_str(&fs::read_to_string(dir().join(name)).ok()?).ok()
}

fn write<T: Serialize>(name: &str, value: &T) {
    fs::create_dir_all(dir()).ok();
    if let Ok(text) = serde_json::to_string_pretty(value) {
        utils::atomic_write(&dir().join(name), &text).ok();
    }
}

fn remove(name: &str) {
    fs::remove_file(dir().join(name)).ok();
}

fn crc(data: &[u8]) -> String {
    if data.is_empty() {
        return String::new();
    }
    let mut crc = flate2::Crc::new();
    crc.update(data);
    format!("{:08x}", crc.sum())
}

fn stored_settings() -> Map<String, Value> {
    let data = serde_json::to_value(&*crate::CONFIG.lock().unwrap())
        .map(|mut config| config["data"].take())
        .unwrap_or(Value::Null);
    let defaults = config::defaults();
    data.as_object()
        .map(|data| {
            data.iter()
                .filter(|(key, _)| defaults.get(*key).is_some_and(|value| !value.is_null()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

pub fn snapshot() -> Snapshot {
    let settings = stored_settings();
    let on = |key: &str| settings.get(key).and_then(Value::as_bool).unwrap_or(true);
    let scripts = if on("userscripts") {
        userscripts::GROUPS
            .iter()
            .flat_map(|(group, ..)| userscripts::load_group(group))
            .filter(|script| script.enabled)
            .map(|script| (script.key.clone(), crc(script.source.as_bytes())))
            .collect()
    } else {
        BTreeMap::new()
    };
    let swaps = if on("swapper") {
        crc(swapper::list()["files"].to_string().as_bytes())
    } else {
        String::new()
    };
    let swaps = if swaps == crc(b"[]") { String::new() } else { swaps };
    let custom_css = if on("customCss") {
        crc(crate::modules::custom_css::read().trim().as_bytes())
    } else {
        String::new()
    };
    Snapshot {
        kute: env!("CARGO_PKG_VERSION").to_string(),
        scripts,
        user_flags: flaglist::user_flags(),
        blocklist: crc(crate::modules::blocklist::user_entries()
            .join(
                "
",
            )
            .as_bytes()),
        swaps,
        custom_css,
        // only an auto-update build ever runs a downloaded bundle
        bundle: if cfg!(feature = "auto-update") {
            crc(&fs::read(utils::exe_dir().join("resources/bundle.js")).unwrap_or_default())
        } else {
            String::new()
        },
        settings,
    }
}

fn engine_items(now: &Snapshot) -> Vec<Item> {
    let mut items = Vec::new();
    #[cfg(windows)]
    if now.settings.get("hardFlip").and_then(Value::as_bool).unwrap_or(true) {
        items.push(Item::Setting {
            key: "hardFlip".to_string(),
            value: false.into(),
        });
    }
    for patch in app::PATCHES {
        if now.settings.get(patch.setting).and_then(Value::as_bool).unwrap_or(patch.default) {
            items.push(Item::Setting {
                key: patch.setting.to_string(),
                value: false.into(),
            });
        }
    }
    items
}

/// what a test can switch back: what changed since the setup that ran, or everything the player added without one
pub fn candidates(now: &Snapshot, good: Option<&Snapshot>, defaults: &Map<String, Value>) -> Vec<Item> {
    let mut items: Vec<Item> = Vec::new();
    let mut push = |item: Item| {
        if !items.contains(&item) {
            items.push(item);
        }
    };
    match good {
        Some(good) => {
            for (key, value) in &now.settings {
                if let Some(before) = good.settings.get(key).filter(|before| *before != value) {
                    push(Item::Setting {
                        key: key.clone(),
                        value: before.clone(),
                    });
                }
            }
            for (key, sum) in &now.scripts {
                if good.scripts.get(key) != Some(sum) {
                    push(Item::Script { key: key.clone() });
                }
            }
            for flag in now.user_flags.iter().filter(|flag| !good.user_flags.contains(flag)) {
                push(Item::UserFlag { flag: flag.clone() });
            }
            if now.blocklist != good.blocklist {
                push(Item::UserBlocklist);
            }
            if !now.swaps.is_empty() && now.swaps != good.swaps {
                push(Item::Swaps);
            }
            if !now.custom_css.is_empty() && now.custom_css != good.custom_css {
                push(Item::CustomCss);
            }
            if !now.bundle.is_empty() && now.bundle != good.bundle {
                push(Item::DownloadedBundle);
            }
            // a new exe brings new engine code, the setup may not have changed at all
            if now.kute != good.kute {
                for item in engine_items(now) {
                    push(item);
                }
            }
        }
        None => {
            for key in now.scripts.keys() {
                push(Item::Script { key: key.clone() });
            }
            for flag in &now.user_flags {
                push(Item::UserFlag { flag: flag.clone() });
            }
            if !now.blocklist.is_empty() {
                push(Item::UserBlocklist);
            }
            if !now.swaps.is_empty() {
                push(Item::Swaps);
            }
            if !now.custom_css.is_empty() {
                push(Item::CustomCss);
            }
            if !now.bundle.is_empty() {
                push(Item::DownloadedBundle);
            }
            for key in SAFE_DEFAULTS {
                if let (Some(value), Some(default)) = (now.settings.get(key), defaults.get(key))
                    && value != default
                {
                    push(Item::Setting {
                        key: key.to_string(),
                        value: default.clone(),
                    });
                }
            }
            for item in engine_items(now) {
                push(item);
            }
        }
    }
    items
}

fn label(item: &Item) -> String {
    match item {
        Item::Setting { key, value } => {
            let name = config::setting_name(key).unwrap_or_else(|| key.clone());
            match value {
                Value::Bool(false) => format!("{name} (setting)"),
                _ => format!("{name} set to {value} (setting)"),
            }
        }
        Item::Script { key } => format!("Userscript {}", key.rsplit('/').next().unwrap_or(key)),
        Item::UserFlag { flag } => format!("Chromium flag {flag} (user_flags.json)"),
        Item::UserBlocklist => "Your blocklist entries (user_blocklist.json)".to_string(),
        Item::Swaps => "Resource swapper files".to_string(),
        Item::CustomCss => "Custom CSS".to_string(),
        Item::DownloadedBundle => "The downloaded Kute script update".to_string(),
    }
}

fn overrides_for(items: &[Item], active: &[usize]) -> Overrides {
    let mut overrides = Overrides::default();
    for (_, item) in items.iter().enumerate().filter(|(index, _)| !active.contains(index)) {
        match item {
            Item::Setting { key, value } => {
                overrides.settings.insert(key.clone(), value.clone());
            }
            Item::Script { key } => overrides.scripts_off.push(key.clone()),
            Item::UserFlag { flag } => overrides.user_flags_off.push(flag.clone()),
            Item::UserBlocklist => overrides.no_user_blocklist = true,
            Item::Swaps => {
                overrides.settings.insert("swapper".to_string(), false.into());
            }
            Item::CustomCss => {
                overrides.settings.insert("customCss".to_string(), false.into());
            }
            Item::DownloadedBundle => overrides.embedded_bundle = true,
        }
    }
    overrides
}

fn safe_overrides() -> Overrides {
    let defaults = config::defaults();
    let mut settings: Map<String, Value> = SAFE_DEFAULTS
        .iter()
        .filter_map(|key| Some((key.to_string(), defaults.get(*key)?.clone())))
        .collect();
    for key in SAFE_OFF {
        settings.insert(key.to_string(), false.into());
    }
    Overrides {
        settings,
        no_user_flags: true,
        no_user_blocklist: true,
        embedded_bundle: true,
        ..Default::default()
    }
}

fn classify(session: &Session) -> Ended {
    if session.crashed.is_some() {
        Ended::Crashed
    } else if session.renderer_crashes > 0 {
        Ended::Renderer
    } else if session.milestone == "start" {
        Ended::Early
    } else {
        Ended::Unknown
    }
}

fn record(history: &mut History, session: &Session, ended: Ended) {
    history.outcomes.push(Outcome {
        ended,
        milestone: session.milestone.clone(),
        uptime_ms: session.uptime_ms,
        mode: session.mode,
    });
    let excess = history.outcomes.len().saturating_sub(MAX_OUTCOMES);
    history.outcomes.drain(..excess);
    // tests and safe mode are expected to crash sometimes, they say nothing about the player's setup
    if session.mode == Mode::Normal {
        if ended.bad() {
            history.bad_streak += 1;
        } else if ended == Ended::Clean {
            history.bad_streak = 0;
        }
    }
}

// a test's verdict, from the start after it or from its own clean exit. nothing when it ended too soon to say
fn settle_probe(session: &Session, ended: Ended) {
    let (Some(active), Some(mut bisect)) = (session.probe.clone(), read::<Bisect>("bisect.json")) else {
        return;
    };
    if bisect.search.next().as_ref() != Some(&active) {
        return;
    }
    let crashed = ended.bad();
    if !crashed && !session.survived {
        return;
    }
    bisect.search.report(crashed);
    bisect.tests.push(TestRecord { active, crashed });
    debug_print!("recovery: test {} {}", bisect.tests.len(), if crashed { "crashed" } else { "ran fine" });
    write("bisect.json", &bisect);
}

fn new_bisect(history: &History) -> Option<Bisect> {
    let items = candidates(&snapshot(), read::<Snapshot>("known-good.json").as_ref(), &config::defaults());
    if items.is_empty() {
        return None;
    }
    let streak: Vec<&Outcome> = history
        .outcomes
        .iter()
        .rev()
        .filter(|outcome| outcome.mode == Mode::Normal)
        .take(history.bad_streak.max(1) as usize)
        .collect();
    let soon = |outcome: &&Outcome| outcome.milestone == "start" || outcome.uptime_ms.is_some_and(|ms| ms < STARTUP_WINDOW_MS);
    let kind = if streak.iter().all(soon) { Kind::Startup } else { Kind::Play };
    let times: Vec<u64> = streak.iter().filter_map(|outcome| outcome.uptime_ms).collect();
    let threshold_ms = if times.is_empty() {
        if kind == Kind::Startup { FALLBACK_STARTUP_MS } else { FALLBACK_PLAY_MS }
    } else {
        SURVIVE_FACTOR * times.iter().sum::<u64>() / times.len() as u64
    };
    Some(Bisect {
        kind,
        search: Ddmin::new(items.len()),
        items,
        tests: Vec::new(),
        threshold_ms,
    })
}

// the linux host has no dialog yet, the page offers safe mode there
#[cfg_attr(target_os = "linux", allow(dead_code))]
#[derive(PartialEq)]
enum Choice {
    Normal,
    Safe,
    Find,
}

#[cfg(windows)]
fn shift_held() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_SHIFT};
    unsafe { GetAsyncKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000 != 0 }
}

#[cfg(target_os = "linux")]
fn shift_held() -> bool {
    false
}

#[cfg(windows)]
fn ask(can_find: bool) -> Option<Choice> {
    use windows::{Win32::UI::Controls::*, core::*};
    const BTN_SAFE: i32 = 200;
    const BTN_FIND: i32 = 201;
    const BTN_REPORT: i32 = 202;
    const BTN_NORMAL: i32 = 203;
    // the dialog's activation context stays on its thread, the main thread goes on to create cef's windows
    std::thread::spawn(move || {
        let task_dialog = crate::modules::updater::load_task_dialog()?;
        loop {
            let wide = |text: &str| utils::create_utf_string(text);
            let title = wide("Kute");
            let main = wide("Kute crashed the last times it ran");
            let content = wide("Nothing of yours gets changed by any of these.");
            let mut labels = vec![(
                BTN_SAFE,
                wide("Start in safe mode\nWithout your userscripts, swaps, custom CSS, flags and engine tweaks, this start only"),
            )];
            if can_find {
                labels.push((
                    BTN_FIND,
                    wide("Find the cause\nKute starts a few times with parts switched off and tells you which one it is"),
                ));
            }
            labels.push((BTN_REPORT, wide("Save a diagnostics report\nOne file for a bug report, saved to Downloads")));
            labels.push((BTN_NORMAL, wide("Start normally")));
            let buttons: Vec<TASKDIALOG_BUTTON> = labels
                .iter()
                .map(|(id, text)| TASKDIALOG_BUTTON {
                    nButtonID: *id,
                    pszButtonText: PCWSTR(text.as_ptr()),
                })
                .collect();
            let config = TASKDIALOGCONFIG {
                cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
                dwFlags: TDF_USE_COMMAND_LINKS | TDF_ALLOW_DIALOG_CANCELLATION,
                pszWindowTitle: PCWSTR(title.as_ptr()),
                Anonymous1: TASKDIALOGCONFIG_0 { pszMainIcon: TD_WARNING_ICON },
                pszMainInstruction: PCWSTR(main.as_ptr()),
                pszContent: PCWSTR(content.as_ptr()),
                cButtons: buttons.len() as u32,
                pButtons: buttons.as_ptr(),
                nDefaultButton: BTN_SAFE,
                ..Default::default()
            };
            let mut pressed = 0i32;
            unsafe { task_dialog(&config, &mut pressed, std::ptr::null_mut(), std::ptr::null_mut()) }
                .ok()
                .ok()?;
            match pressed {
                BTN_SAFE => return Some(Choice::Safe),
                BTN_FIND => return Some(Choice::Find),
                BTN_REPORT => {
                    crate::modules::diagnostics::save_without_page();
                }
                // start normally, or the dialog closed
                _ => return Some(Choice::Normal),
            }
        }
    })
    .join()
    .ok()
    .flatten()
}

#[cfg(target_os = "linux")]
fn ask(_can_find: bool) -> Option<Choice> {
    None
}

fn clear_gpu_caches() {
    let profile = utils::settings_dir().join("cef");
    for folder in [
        "GPUCache",
        "ShaderCache",
        "GrShaderCache",
        "GraphiteDawnCache",
        "DawnGraphiteCache",
        "DawnWebGPUCache",
    ] {
        fs::remove_dir_all(profile.join(folder)).ok();
        fs::remove_dir_all(profile.join("Default").join(folder)).ok();
    }
}

fn apply(overrides: Overrides) {
    if let Ok(text) = serde_json::to_string(&overrides) {
        // before cef starts any thread that reads the environment
        unsafe { std::env::set_var(ENV, text) };
    }
    *OVERRIDES.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(overrides);
}

/// browser process, before anything reads a setting for cef: the last session's ending, the dialog, this session's overrides
pub fn start() {
    let mut history: History = read("history.json").unwrap_or_default();
    if let Some(previous) = read::<Session>("session.json") {
        let ended = classify(&previous);
        record(&mut history, &previous, ended);
        if previous.mode == Mode::Probe {
            settle_probe(&previous, ended);
        }
        remove("session.json");
    }

    let restarted = std::env::args().any(|arg| crate::modules::lifecycle::is_internal_arg(&arg));
    let mut bisect = read::<Bisect>("bisect.json");
    let mut mode = Mode::Normal;
    if utils::has_arg(SAFE_ARG) || (!restarted && shift_held()) {
        mode = Mode::Safe;
    } else if bisect.as_ref().is_some_and(|bisect| bisect.search.verdict.is_none()) {
        mode = Mode::Probe;
    } else if bisect.as_ref().is_some_and(|bisect| matches!(bisect.search.verdict, Some(Verdict::Culprit(_)))) {
        mode = Mode::Result;
    } else if history.bad_streak >= BAD_STREAK_ASK && bisect.is_none() {
        let fresh = new_bisect(&history);
        match ask(fresh.is_some()) {
            Some(Choice::Safe) => mode = Mode::Safe,
            Some(Choice::Find) if fresh.is_some() => {
                write("bisect.json", &fresh);
                bisect = fresh;
                mode = Mode::Probe;
                history.bad_streak = 0;
            }
            Some(_) => history.bad_streak = 0,
            None => *OFFER.lock().unwrap() = true,
        }
    }
    write("history.json", &history);

    let mut session = Session {
        started: now_secs(),
        milestone: "start".to_string(),
        mode,
        ..Default::default()
    };
    match mode {
        Mode::Safe => {
            clear_gpu_caches();
            apply(safe_overrides());
        }
        Mode::Probe => {
            if let Some(bisect) = &bisect
                && let Some(active) = bisect.search.next()
            {
                apply(overrides_for(&bisect.items, &active));
                session.probe = Some(active);
                watch_survival(bisect.threshold_ms);
            }
        }
        Mode::Result => {
            if let Some(bisect) = &bisect
                && let Some(Verdict::Culprit(culprits)) = &bisect.search.verdict
            {
                let keep: Vec<usize> = (0..bisect.items.len()).filter(|index| !culprits.contains(index)).collect();
                apply(overrides_for(&bisect.items, &keep));
            }
        }
        Mode::Normal => {}
    }
    debug_print!("recovery: {mode:?}, bad streak {}", history.bad_streak);
    write("session.json", &session);
    *SESSION.lock().unwrap() = Some(session);
}

fn uptime_ms() -> u64 {
    eventlog::START.elapsed().as_millis() as u64
}

fn mode() -> Mode {
    SESSION.lock().unwrap().as_ref().map(|session| session.mode).unwrap_or_default()
}

pub fn milestone(name: &str) {
    let rank = |milestone: &str| ["start", "loaded", "match"].iter().position(|known| *known == milestone).unwrap_or(0);
    let mut guard = SESSION.lock().unwrap();
    let Some(session) = guard.as_mut() else { return };
    if rank(name) <= rank(&session.milestone) {
        return;
    }
    session.milestone = name.to_string();
    session.uptime_ms = Some(uptime_ms());
    write("session.json", session);
    let probing = session.mode == Mode::Probe;
    drop(guard);
    if probing {
        check_survival();
    }
}

fn watch_survival(threshold_ms: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(threshold_ms.saturating_sub(uptime_ms())));
        check_survival();
    });
}

fn check_survival() {
    let Some(bisect) = read::<Bisect>("bisect.json") else { return };
    let mut guard = SESSION.lock().unwrap();
    let Some(session) = guard.as_mut() else { return };
    let loaded = session.milestone != "start";
    if session.survived || session.renderer_crashes > 0 || uptime_ms() < bisect.threshold_ms || (bisect.kind == Kind::Startup && !loaded) {
        return;
    }
    session.survived = true;
    session.uptime_ms = Some(uptime_ms());
    write("session.json", session);
    drop(guard);
    debug_print!("recovery: this test ran fine");
    match bisect.kind {
        Kind::Startup => restart_later(None),
        // the linux host has no main browser lookup yet, the page sees it on its next load
        #[cfg(windows)]
        Kind::Play => crate::bridge::post_json_to_main_later(json!({ "recovery": page_info() }).to_string()),
        #[cfg(target_os = "linux")]
        Kind::Play => {}
    }
}

/// a renderer that died on its own. a test restarts into the next one
pub fn renderer_crashed() {
    let mut guard = SESSION.lock().unwrap();
    let Some(session) = guard.as_mut() else { return };
    session.renderer_crashes += 1;
    session.uptime_ms = Some(uptime_ms());
    write("session.json", session);
    let probing = session.mode == Mode::Probe;
    drop(guard);
    if probing {
        restart_later(None);
    }
}

/// panic hook and crash filter: never blocks, never panics. true when a test continues by itself and no box should show
pub fn on_crash(reason: &str) -> bool {
    let Ok(mut guard) = SESSION.try_lock() else { return false };
    let Some(session) = guard.as_mut() else { return false };
    session.crashed = Some(reason.chars().take(200).collect());
    session.uptime_ms = Some(uptime_ms());
    if let Ok(text) = serde_json::to_string(&*session) {
        fs::write(dir().join("session.json"), text).ok();
    }
    if session.mode != Mode::Probe {
        return false;
    }
    let args: Vec<String> = crate::LAUNCH_ARGS.try_lock().map(|args| args.clone()).unwrap_or_default();
    if let Ok(exe) = std::env::current_exe() {
        std::process::Command::new(exe)
            .args(args)
            .arg(crate::modules::lifecycle::wait_pid_arg())
            .env_remove(ENV)
            .spawn()
            .ok();
    }
    true
}

/// end of main: the session ended the regular way
pub fn clean_exit() {
    let Some(session) = SESSION.lock().unwrap().take() else { return };
    let ended = if session.renderer_crashes > 0 { Ended::Renderer } else { Ended::Clean };
    let mut history: History = read("history.json").unwrap_or_default();
    let session = Session {
        uptime_ms: Some(uptime_ms()),
        ..session
    };
    record(&mut history, &session, ended);
    write("history.json", &history);
    if session.mode == Mode::Probe {
        settle_probe(&session, ended);
    }
    let proven = session.milestone == "match" || (session.milestone == "loaded" && uptime_ms() >= KNOWN_GOOD_MS);
    if session.mode == Mode::Normal && ended == Ended::Clean && proven {
        write("known-good.json", &snapshot());
    }
    remove("session.json");
}

mod task {
    use cef::{rc::*, *};

    wrap_task! {
        pub struct RestartTask {
            safe: Option<bool>,
        }

        impl Task {
            fn execute(&self) {
                super::restart_now(self.safe);
            }
        }
    }

    pub fn post(safe: Option<bool>) {
        let mut task = RestartTask::new(safe);
        post_task(ThreadId::UI, Some(&mut task));
    }
}

// Some(true): into safe mode, Some(false): out of it, None: as started
fn restart_now(safe: Option<bool>) {
    {
        let mut args = crate::LAUNCH_ARGS.lock().unwrap();
        if safe.is_some() {
            args.retain(|arg| arg != SAFE_ARG);
        }
        if safe == Some(true) {
            args.push(SAFE_ARG.to_string());
        }
    }
    crate::modules::lifecycle::restart();
}

fn restart_later(safe: Option<bool>) {
    task::post(safe);
}

fn result_info(bisect: &Bisect) -> Value {
    let crashed = bisect.tests.iter().filter(|test| test.crashed).count();
    let culprits: Vec<Value> = match &bisect.search.verdict {
        Some(Verdict::Culprit(indices)) => indices
            .iter()
            .filter_map(|index| bisect.items.get(*index))
            .map(|item| json!({ "label": label(item), "fixable": fixable(item) }))
            .collect(),
        _ => Vec::new(),
    };
    json!({
        "mode": "result",
        "verdict": if culprits.is_empty() { "notTheSetup" } else { "culprit" },
        "culprits": culprits,
        "tests": { "crashed": crashed, "ranFine": bisect.tests.len() - crashed },
    })
}

fn fixable(item: &Item) -> bool {
    matches!(item, Item::Setting { .. } | Item::Script { .. } | Item::Swaps | Item::CustomCss)
}

/// what the page shows: a safe mode banner, a test's progress, a result, or the offer when no dialog could ask
pub fn page_info() -> Value {
    let session = SESSION.lock().unwrap().clone();
    let Some(session) = session else { return Value::Null };
    let bisect = read::<Bisect>("bisect.json");
    match session.mode {
        Mode::Safe => {
            json!({ "mode": "safe", "canFind": !candidates(&snapshot(), read::<Snapshot>("known-good.json").as_ref(), &config::defaults()).is_empty() })
        }
        Mode::Probe => match bisect {
            Some(bisect) => json!({
                "mode": "test",
                "kind": bisect.kind,
                "step": bisect.tests.len() + 1,
                "suspects": bisect.search.suspects.len(),
                "minutes": bisect.threshold_ms.div_ceil(60_000),
                "ranFine": session.survived,
            }),
            None => Value::Null,
        },
        Mode::Result => bisect.map(|bisect| result_info(&bisect)).unwrap_or(Value::Null),
        Mode::Normal => match bisect {
            Some(bisect) if bisect.search.verdict.is_some() => result_info(&bisect),
            _ if *OFFER.lock().unwrap() => json!({ "mode": "offer" }),
            _ => Value::Null,
        },
    }
}

pub fn window_title() -> String {
    let session = SESSION.lock().unwrap().clone();
    match session.map(|session| session.mode) {
        Some(Mode::Safe) => "Kute (safe mode)".to_string(),
        Some(Mode::Probe) => {
            let step = read::<Bisect>("bisect.json").map(|bisect| bisect.tests.len() + 1).unwrap_or(1);
            format!("Kute (finding the cause, test {step})")
        }
        _ => "Kute".to_string(),
    }
}

fn apply_culprits(bisect: &Bisect) {
    let Some(Verdict::Culprit(indices)) = &bisect.search.verdict else { return };
    for item in indices.iter().filter_map(|index| bisect.items.get(*index)) {
        match item {
            Item::Setting { key, value } => crate::CONFIG.lock().unwrap().set(key, value.clone()),
            Item::Script { key } => userscripts::set_enabled(key, false),
            Item::Swaps => crate::CONFIG.lock().unwrap().set("swapper", false),
            Item::CustomCss => crate::CONFIG.lock().unwrap().set("customCss", false),
            _ => {}
        }
    }
    config::save_soon();
}

/// recovery-<command> from the page
pub fn command(command: &str) {
    match command {
        "safe" => restart_now(Some(true)),
        "normal" => restart_now(Some(false)),
        "find" => {
            let history: History = read("history.json").unwrap_or_default();
            if let Some(bisect) = new_bisect(&history) {
                write("bisect.json", &bisect);
                restart_now(Some(false));
            }
        }
        "stop" => {
            remove("bisect.json");
            restart_now(Some(false));
        }
        "next" if mode() == Mode::Probe => restart_now(None),
        "apply" => {
            if let Some(bisect) = read::<Bisect>("bisect.json") {
                apply_culprits(&bisect);
            }
            remove("bisect.json");
        }
        "dismiss" => {
            if read::<Bisect>("bisect.json").is_some_and(|bisect| bisect.search.verdict.is_some()) {
                remove("bisect.json");
            }
            *OFFER.lock().unwrap() = false;
            let mut history: History = read("history.json").unwrap_or_default();
            history.bad_streak = 0;
            write("history.json", &history);
        }
        _ => {}
    }
}

/// for the diagnostics report
pub fn report() -> Value {
    json!({
        "session": *SESSION.lock().unwrap(),
        "history": read::<Value>("history.json"),
        "knownGood": read::<Value>("known-good.json"),
        "bisect": read::<Value>("bisect.json"),
        "overrides": *overrides(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Snapshot {
        let mut settings = Map::new();
        settings.insert("hardFlip".to_string(), true.into());
        settings.insert("angleBackend".to_string(), "Default".into());
        settings.insert("menuTimer".to_string(), true.into());
        for patch in app::PATCHES {
            settings.insert(patch.setting.to_string(), patch.default.into());
        }
        Snapshot {
            kute: "1.0.0".to_string(),
            settings,
            ..Default::default()
        }
    }

    #[test]
    fn only_what_changed_since_the_setup_that_ran() {
        let good = setup();
        let mut now = setup();
        now.settings.insert("angleBackend".to_string(), "Vulkan".into());
        now.scripts.insert("game/a.js".to_string(), "1".to_string());
        now.user_flags.push("--foo".to_string());
        let items = candidates(&now, Some(&good), &Map::new());
        assert_eq!(
            items,
            vec![
                Item::Setting {
                    key: "angleBackend".to_string(),
                    value: "Default".into()
                },
                Item::Script { key: "game/a.js".to_string() },
                Item::UserFlag { flag: "--foo".to_string() },
            ]
        );
    }

    #[test]
    fn a_new_exe_adds_the_engine_switches() {
        let good = setup();
        let mut now = setup();
        now.kute = "1.1.0".to_string();
        let items = candidates(&now, Some(&good), &Map::new());
        let patches_on = app::PATCHES.iter().filter(|patch| patch.default).count();
        assert_eq!(items.len(), patches_on + usize::from(cfg!(windows)));
        assert!(items.iter().all(|item| matches!(item, Item::Setting { value: Value::Bool(false), .. })));
    }

    #[test]
    fn a_test_switches_back_what_it_does_not_keep() {
        let items = vec![
            Item::Script { key: "game/a.js".to_string() },
            Item::Swaps,
            Item::Setting {
                key: "hardFlip".to_string(),
                value: false.into(),
            },
        ];
        let overrides = overrides_for(&items, &[1]);
        assert_eq!(overrides.scripts_off, vec!["game/a.js".to_string()]);
        assert_eq!(overrides.settings.get("hardFlip"), Some(&Value::Bool(false)));
        assert!(!overrides.settings.contains_key("swapper"));
    }

    #[test]
    fn tests_and_safe_mode_leave_the_streak_alone() {
        let mut history = History::default();
        let session = |mode| Session {
            mode,
            milestone: "start".to_string(),
            ..Default::default()
        };
        record(&mut history, &session(Mode::Normal), Ended::Early);
        record(&mut history, &session(Mode::Probe), Ended::Crashed);
        record(&mut history, &session(Mode::Normal), Ended::Unknown);
        assert_eq!(history.bad_streak, 1);
        record(&mut history, &session(Mode::Normal), Ended::Clean);
        assert_eq!(history.bad_streak, 0);
    }
}
