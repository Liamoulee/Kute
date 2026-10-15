// auto-detect's fixed input script, the same circles and shots as the windows SendInput replay (modules/replay.rs).
// devtools' Input.dispatchMouseEvent: under pointer lock the page gets the position deltas as movementX/Y, trusted.
// cef's own send_mouse_move_event does not, its locked movement comes out as screen offsets
use crate::{bridge, debug_print, modules::input, window};
use cef::*;
use std::{
    f64::consts::TAU,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

// one circle, a sample asks for a multiple of it so the camera ends where it started
pub const CIRCLE_MS: u64 = 600;
const STEP_MS: u64 = 2;
// mouse counts, about a quarter turn at common sensitivities
const RADIUS: f64 = 300.0;
const FIRE_MS: u64 = 400;
const RELEASE_MS: u64 = 100;
// a page that stalled never sends the stop
const LONGEST_MS: u64 = 8000;
// circle center when the real cursor cannot be read (native wayland)
const FALLBACK_ORIGIN: (f64, f64) = (600.0, 400.0);

static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
enum Step {
    Move,
    Press,
    Release,
}

wrap_task! {
    struct MouseTask {
        browser_id: i32,
        step: Step,
        x: i32,
        y: i32,
        held: bool,
    }

    impl Task {
        fn execute(&self) {
            let Some(browser) = window::browser_by_id(self.browser_id) else { return };
            let kind = match self.step {
                Step::Move => "mouseMoved",
                Step::Press => "mousePressed",
                Step::Release => "mouseReleased",
            };
            crate::modules::devtools::mouse_event(&browser, kind, self.x, self.y, self.held);
        }
    }
}

// devtools calls belong on the ui thread, this thread only keeps the time
fn send(browser_id: i32, step: Step, (x, y): (f64, f64), held: bool) {
    let mut task = MouseTask::new(browser_id, step, x.round() as i32, y.round() as i32, held);
    post_task(ThreadId::UI, Some(&mut task));
}

// the real cursor in the window, css px. chromium's locked movementX/Y is the difference to the last position it knows,
// which is the real cursor's: a circle from anywhere else turned the view by that gap at the start and back at the
// next real move (measured 319 counts each way on the owner's pc)
fn real_cursor(window: u64, scale: f64) -> Option<(f64, f64)> {
    use x11rb::protocol::xproto::ConnectionExt as _;
    let window = u32::try_from(window).ok().filter(|&window| window != 0)?;
    let (connection, _) = x11rb::connect(None).ok()?;
    let pointer = connection.query_pointer(window).ok()?.reply().ok()?;
    pointer.same_screen.then(|| (pointer.win_x as f64 / scale, pointer.win_y as f64 / scale))
}

// the page gets `{inputReplay: {sent, reason}}` when a script ends: a report without pointer events has to say why
pub fn start(window: u64, browser_id: i32, ms: u64) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let ms = ms.min(LONGEST_MS);
    let scale = window::browser_by_id(browser_id).map(|browser| window::device_scale(&browser)).unwrap_or(1.0);
    // the circle starts and ends on the real cursor
    let origin = real_cursor(window, scale).map(|(x, y)| (x - RADIUS, y)).unwrap_or(FALLBACK_ORIGIN);
    thread::spawn(move || {
        let started = Instant::now();
        let mut position = (origin.0 + RADIUS, origin.1);
        let mut fire = false;
        let mut sent = 0u64;
        send(browser_id, Step::Move, position, false);
        let reason = loop {
            if GENERATION.load(Ordering::SeqCst) != generation {
                break "stopped";
            }
            if !input::pointer_locked() {
                break "the game did not hold the mouse";
            }
            if !window::main_window_active() {
                break "Kute was not the window in front";
            }
            let elapsed = started.elapsed().as_millis() as u64;
            if elapsed >= ms {
                break "done";
            }
            let angle = TAU * (elapsed % CIRCLE_MS) as f64 / CIRCLE_MS as f64;
            // absolute points on the circle: the rounding of one step never carries into the next
            let target = (origin.0 + RADIUS * angle.cos(), origin.1 + RADIUS * angle.sin());
            position = (target.0.round(), target.1.round());
            send(browser_id, Step::Move, position, fire);
            let want_fire = elapsed % (FIRE_MS + RELEASE_MS) < FIRE_MS;
            if want_fire != fire {
                send(browser_id, if want_fire { Step::Press } else { Step::Release }, position, want_fire);
                fire = want_fire;
            }
            sent += 1;
            thread::sleep(Duration::from_millis(STEP_MS));
        };
        // back to where the circle began so readings never drift the view; the button is always released
        if matches!(reason, "done" | "stopped") && input::pointer_locked() {
            send(browser_id, Step::Move, (origin.0 + RADIUS, origin.1), fire);
        }
        if fire {
            send(browser_id, Step::Release, position, false);
        }
        debug_print!("replay: {sent} input steps in {} ms, {reason}", started.elapsed().as_millis());
        bridge::post_json_later(browser_id, serde_json::json!({ "inputReplay": { "sent": sent, "reason": reason } }).to_string());
    });
}

pub fn stop() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}
