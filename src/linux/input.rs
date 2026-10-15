// no host-level input hook here (the windows one subclasses chromium's widget). ramp boost is a key press the browser
// host sends itself: trusted in the page, nothing leaves the client
use crate::{bridge, window};
use cef::*;
use std::sync::atomic::{AtomicBool, Ordering};

static POINTER_LOCKED: AtomicBool = AtomicBool::new(false);
static RAMPBOOST: AtomicBool = AtomicBool::new(false);
// windows holds the space for 5 ms between SendInput's down and up
const SPACE_MS: i64 = 5;
const VK_SPACE: i32 = 0x20;
// x11 keycode of space (evdev 57 + 8)
const SPACE_KEYCODE: i32 = 65;

pub fn set_pointer_locked(locked: bool) {
    POINTER_LOCKED.store(locked, Ordering::Relaxed);
}

pub fn pointer_locked() -> bool {
    POINTER_LOCKED.load(Ordering::Relaxed)
}

pub fn set_rampboost(enabled: bool) {
    RAMPBOOST.store(enabled, Ordering::Relaxed);
}

fn space(browser: &Browser, types: &[KeyEventType]) {
    let Some(host) = browser.host() else { return };
    for type_ in types {
        let event = KeyEvent {
            type_: *type_,
            windows_key_code: VK_SPACE,
            native_key_code: SPACE_KEYCODE,
            character: VK_SPACE as u16,
            unmodified_character: VK_SPACE as u16,
            ..Default::default()
        };
        host.send_key_event(Some(&event));
    }
}

wrap_task! {
    struct SpaceUpTask {
        browser_id: i32,
    }

    impl Task {
        fn execute(&self) {
            if let Some(browser) = window::browser_by_id(self.browser_id) {
                space(&browser, &[KeyEventType::KEYUP]);
            }
        }
    }
}

// a wheel tick the page swallowed while locked (rampBoost.js): the keystrokes widget hears about it first, then the jump
pub fn ramp_wheel(browser: &Browser, up: bool) {
    if !RAMPBOOST.load(Ordering::Relaxed) || !pointer_locked() {
        return;
    }
    bridge::post_json(browser, &serde_json::json!({ "rampWheel": if up { 1 } else { -1 } }).to_string());
    space(browser, &[KeyEventType::RAWKEYDOWN, KeyEventType::CHAR]);
    let mut task = SpaceUpTask::new(browser.identifier());
    post_delayed_task(ThreadId::UI, Some(&mut task), SPACE_MS);
}

// pulseaudio and pipewire capture per application, OBS needs no window here
pub fn spawn_audio_window_thread() {}
