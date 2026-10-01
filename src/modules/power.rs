use std::sync::atomic::{AtomicBool, Ordering};

use windows::{
    Win32::System::{LibraryLoader::*, Power::*},
    core::*,
};

use crate::{CONFIG, debug_print, modules};

// windows' power mode overlays (the slider), from powrprof's public guids
const BEST_PERFORMANCE: GUID = GUID::from_u128(0xded574b5_45a0_4f42_8737_46345c09c238);
// windows 10's default on ac. windows 11's "balanced" is the zero guid
const BETTER_PERFORMANCE: GUID = GUID::from_u128(0x3af9b8d9_7c97_431d_ad78_34a8bfea439f);
// "better battery" on windows 10
const BEST_EFFICIENCY: GUID = GUID::from_u128(0x961cc777_2547_4f9d_8174_7d86181b8a7a);

// "balanced" or "better" while kute holds the overlay, so a start after a crash knows it is ours and what to put back
const RESTORE_SETTING: &str = "powerOverlayRestore";

static BOOSTED: AtomicBool = AtomicBool::new(false);
static PREVIOUS_BETTER: AtomicBool = AtomicBool::new(false);

type GetOverlay = unsafe extern "system" fn(*mut GUID) -> u32;
type SetOverlay = unsafe extern "system" fn(*const GUID) -> u32;
type Raw = unsafe extern "system" fn() -> isize;

fn overlay_api() -> Option<(GetOverlay, SetOverlay)> {
    unsafe {
        let library = LoadLibraryW(w!("powrprof.dll")).ok()?;
        let get = GetProcAddress(library, s!("PowerGetEffectiveOverlayScheme"))?;
        let set = GetProcAddress(library, s!("PowerSetActiveOverlayScheme"))?;
        Some((std::mem::transmute::<Raw, GetOverlay>(get), std::mem::transmute::<Raw, SetOverlay>(set)))
    }
}

fn current(get: GetOverlay) -> Option<GUID> {
    let mut overlay = GUID::zeroed();
    (unsafe { get(&mut overlay) } == 0).then_some(overlay)
}

// for the auto-detect report. a mode outside the slider's four (some desktops, vendor tools) is named by its guid:
// calling everything unknown "power saving" told a desktop player something that was probably not true
pub fn overlay_name() -> Option<String> {
    let (get, _) = overlay_api()?;
    Some(match current(get)? {
        overlay if overlay == BEST_PERFORMANCE => "best performance".to_string(),
        overlay if overlay == BETTER_PERFORMANCE => "better performance".to_string(),
        overlay if overlay == GUID::zeroed() => "balanced".to_string(),
        overlay if overlay == BEST_EFFICIENCY => "best power efficiency".to_string(),
        overlay => format!("unknown ({overlay:?})"),
    })
}

// (has a battery, runs on it)
pub fn battery() -> (bool, bool) {
    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
        return (false, false);
    }
    // BatteryFlag 128 = no system battery, 255 = unknown
    let laptop = status.BatteryFlag & 128 == 0 && status.BatteryFlag != 255;
    (laptop, laptop && status.ACLineStatus == 0)
}

// a plugged in laptop on windows' default power mode gets "best performance" while kute runs
pub fn boost() {
    if modules::bench::active() {
        return;
    }
    let Some((get, set)) = overlay_api() else { return };
    let Some(now) = current(get) else { return };
    let mut config = CONFIG.lock().unwrap();
    // a marker from a start that never put the overlay back (crash, kill). adopted before anything else: a start with
    // the setting off or on battery has to put it back too, it used to forget it
    if !BOOSTED.load(Ordering::Relaxed)
        && let Some(previous) = config.get::<String>(RESTORE_SETTING)
    {
        if now == BEST_PERFORMANCE {
            PREVIOUS_BETTER.store(previous == "better", Ordering::Relaxed);
            BOOSTED.store(true, Ordering::Relaxed);
        } else {
            // the player picked another mode meanwhile, nothing of ours is left
            config.set(RESTORE_SETTING, serde_json::Value::Null);
            config.save();
        }
    }
    if !config.get::<bool>("laptopPowerBoost").unwrap_or(true) || battery() != (true, false) {
        drop(config);
        restore();
        return;
    }
    if BOOSTED.load(Ordering::Relaxed) {
        return;
    }
    // anything but windows' two defaults is a mode the player picked on purpose
    let previous = if now == GUID::zeroed() {
        "balanced"
    } else if now == BETTER_PERFORMANCE {
        "better"
    } else {
        return;
    };
    // the marker first: a crash between the two leaves a marker without a boost, which the next start drops
    config.set(RESTORE_SETTING, previous);
    config.save();
    if unsafe { set(&BEST_PERFORMANCE) } == 0 {
        PREVIOUS_BETTER.store(previous == "better", Ordering::Relaxed);
        BOOSTED.store(true, Ordering::Relaxed);
        debug_print!("power: overlay {previous} -> best performance");
    } else {
        config.set(RESTORE_SETTING, serde_json::Value::Null);
        config.save();
    }
}

// only puts back an overlay that is still the one kute set, a mode the player changed meanwhile stays.
// also the panic hook's way out: no config lock (the panicking thread may hold it), the marker then stays for the next start.
// true: nothing of ours is left, the marker can go. a failed set keeps both for the next try
pub fn put_back() -> bool {
    if !BOOSTED.swap(false, Ordering::Relaxed) {
        return false;
    }
    let Some((get, set)) = overlay_api() else { return true };
    if current(get) != Some(BEST_PERFORMANCE) {
        return true;
    }
    let overlay = if PREVIOUS_BETTER.load(Ordering::Relaxed) {
        BETTER_PERFORMANCE
    } else {
        GUID::zeroed()
    };
    if unsafe { set(&overlay) } == 0 {
        return true;
    }
    BOOSTED.store(true, Ordering::Relaxed);
    false
}

pub fn restore() {
    if put_back() {
        let mut config = CONFIG.lock().unwrap();
        config.set(RESTORE_SETTING, serde_json::Value::Null);
        config.save();
    }
}

pub fn on_power_change() {
    if battery() == (true, false) { boost() } else { restore() }
}
