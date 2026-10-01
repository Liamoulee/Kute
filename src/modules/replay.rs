use std::{
    f64::consts::TAU,
    mem,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

use windows::Win32::{
    Foundation::HWND,
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::GetForegroundWindow},
};

use crate::{bridge, debug_print, modules::input};

// auto-detect's fixed input script: the camera turns in circles and the fire button is held with short releases, so
// every sample of a run sees the same mouse traffic and the same shots. real input through the OS, nothing in the page

// one circle, a sample asks for a multiple of it so the camera ends where it started
pub const CIRCLE_MS: u64 = 600;
const STEP_MS: u64 = 2;
// mouse counts, about a quarter turn at common sensitivities
const RADIUS: f64 = 300.0;
const FIRE_MS: u64 = 400;
const RELEASE_MS: u64 = 100;
// a page that stalled never sends the stop
const LONGEST_MS: u64 = 8000;

// bumped by every start and stop, a thread that sees another value than its own ends
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn send(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32) -> bool {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    unsafe { SendInput(&[input], mem::size_of::<INPUT>() as i32) == 1 }
}

// the page gets `{inputReplay: {sent, reason}}` when a script ends: a report without pointer events has to say why
pub fn start(hwnd: HWND, browser_id: i32, ms: u64) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let hwnd = hwnd.0 as isize;
    let ms = ms.min(LONGEST_MS);
    thread::spawn(move || {
        let hwnd = HWND(hwnd as *mut _);
        let started = Instant::now();
        let (mut x, mut y) = (RADIUS, 0.0f64);
        let mut fire = false;
        let mut sent = 0u64;
        let reason = loop {
            if GENERATION.load(Ordering::SeqCst) != generation {
                break "stopped";
            }
            // only into our own window while the game holds the pointer: never into another app the player switched to
            if !input::pointer_locked() {
                break "the game did not hold the mouse";
            }
            if unsafe { GetForegroundWindow() } != hwnd {
                break "Kute was not the window in front";
            }
            let elapsed = started.elapsed().as_millis() as u64;
            if elapsed >= ms {
                break "done";
            }
            let angle = TAU * (elapsed % CIRCLE_MS) as f64 / CIRCLE_MS as f64;
            // whole counts towards the exact point on the circle, so rounding never adds up
            let (dx, dy) = ((RADIUS * angle.cos() - x).round(), (RADIUS * angle.sin() - y).round());
            x += dx;
            y += dy;
            let want_fire = elapsed % (FIRE_MS + RELEASE_MS) < FIRE_MS;
            let mut flags = MOUSEEVENTF_MOVE;
            if want_fire != fire {
                flags |= if want_fire { MOUSEEVENTF_LEFTDOWN } else { MOUSEEVENTF_LEFTUP };
            }
            // blocked input (another process holds the input desktop): stop instead of pretending
            if !send(flags, dx as i32, dy as i32) {
                break "Windows blocked the input";
            }
            fire = want_fire;
            sent += 1;
            thread::sleep(Duration::from_millis(STEP_MS));
        };
        // back to where the circle began: the loop ends between two steps, and what is left of the circle would move the
        // view a little with every reading. only while the mouse is still ours, never into an app the player switched to
        let (dx, dy) = ((RADIUS - x).round() as i32, (-y).round() as i32);
        let ours = input::pointer_locked() && unsafe { GetForegroundWindow() } == hwnd;
        let release = if fire { MOUSEEVENTF_LEFTUP } else { MOUSE_EVENT_FLAGS(0) };
        if ours && matches!(reason, "done" | "stopped") && (dx, dy) != (0, 0) {
            send(MOUSEEVENTF_MOVE | release, dx, dy);
        } else if fire {
            send(MOUSEEVENTF_LEFTUP, 0, 0);
        }
        debug_print!("replay: {sent} input steps in {} ms, {reason}", started.elapsed().as_millis());
        bridge::post_json_later(browser_id, serde_json::json!({ "inputReplay": { "sent": sent, "reason": reason } }).to_string());
    });
}

pub fn stop() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}
