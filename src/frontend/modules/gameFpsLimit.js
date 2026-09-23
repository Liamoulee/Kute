import { kute, ready } from "../client.js";

// The FPS limit is enforced by the host: the present hook sleeps in the GPU process and the patched
// compositor only lets the renderer run one frame ahead, so the game loop follows at the exact rate
// while the main thread stays idle between frames. This module only verifies that this works and
// falls back to a busy-wait when it does not (hook off, OpenGL/Vulkan backend, stock CEF).
//
// Skipping a frame by re-arming requestAnimationFrame is not an option: a frame that draws nothing
// makes the compositor wait out the full 16.6ms deadline, so every limit above 60 collapses.
//
// This is the only code of the client that sits on every frame, so it is written for the frame: measured with a
// CPU profile in a match, the old version (a closure, a settings lookup and a performance.now() per frame, limit
// or not) was 0.89 % of the main thread and all of the bundle's cost. Without a limit nothing of ours runs in
// the frame now, and with one the check uses the timestamp the browser hands over anyway.
//
// DONT TOUCH THIS UNLESS YOU KNOW WHAT YOU'RE DOING :sob:

const nativeRAF = window.requestAnimationFrame;

const CHECK_WINDOW_MS = 2000;
const TOLERANCE = 1.15;

/** @type {Record<string, any> | null} the settings, once the host sent them. read per frame, so no lookups through kute */
let settingsData = null;
ready.then(() => {
    settingsData = kute.settings.data;
});

let nextFrameTime = 0;
let lastFrameTimestamp = -1;
let lastTarget = 0;
let busyWait = false;
let windowStart = -1;
let framesInWindow = 0;
let windowsOverTarget = 0;

/**
 * Counts frames and switches to the busy-wait once the game ran clearly over the limit for two windows in a row.
 *
 * @param {number} targetFps
 * @param {number} timestamp The frame's own time, the same clock as performance.now()
 */
function verifyHostLimiter(targetFps, timestamp){
    if (windowStart < 0) windowStart = timestamp;
    framesInWindow++;
    const elapsed = timestamp - windowStart;
    if (elapsed < CHECK_WINDOW_MS) return;

    const fps = framesInWindow / (elapsed / 1000);
    windowsOverTarget = fps > targetFps * TOLERANCE ? windowsOverTarget + 1 : 0;
    if (windowsOverTarget >= 2) busyWait = true;

    framesInWindow = 0;
    windowStart = timestamp;
}

/**
 * Holds the frame until its slot.
 *
 * @param {number} targetFps
 */
function waitForFrameSlot(targetFps){
    /** @type {number} */
    let targetInterval;
    if (targetFps > 200) targetInterval = 1000 / (targetFps * 1.0055);
    else targetInterval = 1000 / targetFps;

    while (performance.now() < nextFrameTime){
        // busy wait until the next frame slot
    }

    const now = performance.now();

    // also true for the first frame after a limit got set: the slot starts from now
    if (now - nextFrameTime > targetInterval){
        nextFrameTime = now + targetInterval;
    }
    else nextFrameTime += targetInterval;
}

/**
 * Wraps requestAnimationFrame with the limiter check. Callbacks of the same frame share one timestamp,
 * so the work happens once per frame no matter how many callbacks are registered.
 *
 * @param {FrameRequestCallback} callback
 * @return {number}
 */
window.requestAnimationFrame = function(callback){
    // a number, or the string a slider leaves behind. the comparison takes either
    const limit = settingsData === null ? 0 : settingsData.gameFpsLimit;

    // no limit, the usual way to play: the game's callback goes straight to the browser
    if (!(limit > 0)){
        lastTarget = 0;
        return nativeRAF(callback);
    }

    const targetFps = Number(limit);
    return nativeRAF(function(timestamp){
        if (targetFps !== lastTarget){
            // give the host limiter a fresh chance whenever the limit changes
            lastTarget = targetFps;
            busyWait = false;
            framesInWindow = 0;
            windowsOverTarget = 0;
            windowStart = -1;
        }

        if (timestamp !== lastFrameTimestamp){
            lastFrameTimestamp = timestamp;
            if (busyWait) waitForFrameSlot(targetFps);
            else verifyHostLimiter(targetFps, timestamp);
        }

        callback(timestamp);
    });
};
