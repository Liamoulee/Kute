import { kute } from "../client.js";

// The FPS limit is enforced by the host: the present hook sleeps in the GPU process and the patched
// compositor only lets the renderer run one frame ahead, so the game loop follows at the exact rate
// while the main thread stays idle between frames. This module only verifies that this works and
// falls back to a busy-wait when it does not (hook off, OpenGL/Vulkan backend, stock CEF).
//
// Skipping a frame by re-arming requestAnimationFrame is not an option: a frame that draws nothing
// makes the compositor wait out the full 16.6ms deadline, so every limit above 60 collapses.

const nativeRAF = window.requestAnimationFrame;

const CHECK_WINDOW_MS = 2000;
const TOLERANCE = 1.15;

let nextFrameTime = performance.now();
let lastFrameTimestamp = -1;
let lastTarget = 0;
let busyWait = false;
let windowStart = performance.now();
let framesInWindow = 0;
let windowsOverTarget = 0;

/**
 * Counts frames and switches to the busy-wait once the game ran clearly over the limit for two windows in a row.
 *
 * @param {number} targetFps
 */
function verifyHostLimiter(targetFps){
    framesInWindow++;
    const elapsed = performance.now() - windowStart;
    if (elapsed < CHECK_WINDOW_MS) return;

    const fps = framesInWindow / (elapsed / 1000);
    windowsOverTarget = fps > targetFps * TOLERANCE ? windowsOverTarget + 1 : 0;
    if (windowsOverTarget >= 2) busyWait = true;

    framesInWindow = 0;
    windowStart = performance.now();
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
    return nativeRAF(function(timestamp){
        const targetFps = kute?.settings?.data?.gameFpsLimit ?? 0;

        if (targetFps !== lastTarget){
            // give the host limiter a fresh chance whenever the limit changes
            lastTarget = targetFps;
            busyWait = false;
            framesInWindow = 0;
            windowsOverTarget = 0;
            windowStart = performance.now();
        }

        if (timestamp !== lastFrameTimestamp){
            lastFrameTimestamp = timestamp;

            if (targetFps > 0){
                if (busyWait) waitForFrameSlot(targetFps);
                else verifyHostLimiter(targetFps);
            }
            else nextFrameTime = performance.now();
        }

        callback(timestamp);
    });
};
