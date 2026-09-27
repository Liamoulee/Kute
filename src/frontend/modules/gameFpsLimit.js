import { kute, ready } from "../client.js";

// host enforces the limit (present hook + patched cef), this only verifies it and busy-waits as fallback
// runs on every frame, keep it lean. never skip frames by re-arming rAF, limits above 60 collapse
//
// DONT TOUCH THIS UNLESS YOU KNOW WHAT YOU'RE DOING :sob:

const nativeRAF = window.requestAnimationFrame;

const CHECK_WINDOW_MS = 2000;
const TOLERANCE = 1.15;

/** @type {Record<string, any> | null} read per frame, so no lookup through kute */
let settingsData = null;

// every 16th game frame gets timed for the counter's estimate (renderFps.js), the rest go straight to native
const SAMPLE_EVERY = 16;
let rafCalls = 0;
let workMs = 0;
let workSamples = 0;

/**
 * mean main thread time of the sampled game frames since the last call, 0 without samples
 *
 * @return {number}
 */
export function takeFrameWorkMs(){
    const mean = workSamples ? workMs / workSamples : 0;
    workMs = 0;
    workSamples = 0;
    return mean;
}

/**
 * @param {FrameRequestCallback} callback
 * @return {FrameRequestCallback}
 */
function timed(callback){
    return function(timestamp){
        const start = performance.now();
        callback(timestamp);
        workMs += performance.now() - start;
        workSamples++;
    };
}
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
 * @param {number} targetFps
 * @param {number} timestamp frame time, same clock as performance.now()
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

// a hook gap (swap chain switch, resize) could latch the busy-wait for the rest of the page load. a respawn or
// resize hands back to the host limiter, which exists only with the hook on
function recheckHostLimiter(){
    if (!busyWait || !settingsData?.hardFlip) return;
    busyWait = false;
    framesInWindow = 0;
    windowsOverTarget = 0;
    windowStart = -1;
}
document.addEventListener("pointerlockchange", recheckHostLimiter);
window.addEventListener("resize", recheckHostLimiter);

/**
 * @param {number} targetFps
 */
function waitForFrameSlot(targetFps){
    /** @type {number} */
    let targetInterval;
    if (targetFps > 200) targetInterval = 1000 / (targetFps * 1.0055);
    else targetInterval = 1000 / targetFps;

    while (performance.now() < nextFrameTime){
        // spin
    }

    const now = performance.now();

    // also hit on the first frame after setting a limit
    if (now - nextFrameTime > targetInterval){
        nextFrameTime = now + targetInterval;
    }
    else nextFrameTime += targetInterval;
}

/**
 * limiter check runs once per frame timestamp, not per callback
 *
 * @param {FrameRequestCallback} callback
 * @return {number}
 */
window.requestAnimationFrame = function(callback){
    // number or slider string, comparison handles both
    const limit = settingsData === null ? 0 : settingsData.gameFpsLimit;

    // no limit: straight to native, no closure
    if (!(limit > 0)){
        lastTarget = 0;
        if (++rafCalls % SAMPLE_EVERY) return nativeRAF(callback);
        return nativeRAF(timed(callback));
    }

    const targetFps = Number(limit);
    return nativeRAF(function(timestamp){
        if (targetFps !== lastTarget){
            // limit changed, give the host limiter another chance
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
