import { kute, ready } from "../client.js";

// host enforces the limit (present hook + patched cef), this only verifies it and busy-waits as fallback
// runs on every frame, keep it lean. never skip frames by re-arming rAF, limits above 60 collapse
//
// DONT TOUCH THIS UNLESS YOU KNOW WHAT YOU'RE DOING :sob:

const nativeRAF = window.requestAnimationFrame;
const nativeCancelRAF = window.cancelAnimationFrame;

const CHECK_WINDOW_MS = 2000;
const TOLERANCE = 1.15;

/** @type {Record<string, any> | null} read per frame, so no lookup through kute */
let settingsData = null;

// the counter's estimate (renderFps.js): now and then a burst of calls gets wrapped, and each frame in it is timed from
// its first callback to a message that only runs once the frame is rendered, so every callback and the render count
const BURST_EVERY = 256;
const BURST_CALLS = 12;
let rafCalls = 0;
let burstFrames = 0;
let burstFrameTs = -1;
let frameStart = 0;
/** @type {number[]} */
let frameWorkMs = [];
const frameRendered = new MessageChannel();
// pages without the game's counter (social popup) never take the samples
frameRendered.port1.onmessage = () => {
    if (frameWorkMs.length < 512) frameWorkMs.push(performance.now() - frameStart);
};

/**
 * main thread time of a whole frame since the last call, the slowest tenth left out (gc), 0 with too few samples.
 * a mean and not a median: the page clock has 0.1 ms steps
 *
 * @return {number}
 */
export function takeFrameWorkMs(){
    if (frameWorkMs.length < 10) return 0;
    const sorted = frameWorkMs.sort((a, b) => a - b);
    frameWorkMs = [];
    const kept = sorted.slice(0, Math.ceil(sorted.length * 0.9));
    return kept.reduce((sum, ms) => sum + ms, 0) / kept.length;
}

/**
 * @param {FrameRequestCallback} callback
 * @return {FrameRequestCallback}
 */
function timed(callback){
    return function(timestamp){
        if (timestamp !== burstFrameTs){
            burstFrameTs = timestamp;
            // callbacks registered before the burst can run first in its first frame, that one is not whole
            if (burstFrames++ > 0){
                frameStart = performance.now();
                frameRendered.port2.postMessage(0);
            }
        }
        callback(timestamp);
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
    // chromium itself holds the limit (KuteFrameLimiter): the busy wait would only delay every other task by up to 11 ms
    if (windowsOverTarget >= 2 && kute.frameLimiter !== "viz") busyWait = true;

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

/** @type {FrameRequestCallback|null} */
let frameEnd = null;
let frameEndId = 0;
// frame whose callbacks run now or ran last, and the one that was current when the frame end got queued
let frameTs = -1;
let frameEndTs = -2;
// requestFrameWithEnd passes its wrapped callback through requestFrame
let queueingFrameEnd = false;

/**
 * @param {number} timestamp
 */
function runFrameEnd(timestamp){
    frameTs = timestamp;
    frameEnd?.(timestamp);
}

/**
 * limiter check runs once per frame timestamp, not per callback
 *
 * @param {FrameRequestCallback} callback
 * @return {number}
 */
function requestFrame(callback){
    // eslint-disable-next-line no-use-before-define -- the two call each other
    if (frameEnd !== null && !queueingFrameEnd) return requestFrameWithEnd(callback);
    // number or slider string, comparison handles both
    const limit = settingsData === null ? 0 : settingsData.gameFpsLimit;

    // no limit: straight to native, no closure
    if (!(limit > 0)){
        lastTarget = 0;
        const slot = ++rafCalls % BURST_EVERY;
        if (slot >= BURST_CALLS) return nativeRAF(callback);
        if (slot === 0) burstFrames = 0;
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
}

/**
 * requestFrame while a frame end is set
 *
 * @param {FrameRequestCallback} callback
 * @return {number}
 */
function requestFrameWithEnd(callback){
    queueingFrameEnd = true;
    const id = requestFrame((timestamp) => {
        frameTs = timestamp;
        callback(timestamp);
    });
    queueingFrameEnd = false;
    // one queued in this same frame targets the same next frame, move it behind this callback. an older one is
    // due in the frame that runs now, cancelling it starved the frame end for good
    if (frameEndTs === frameTs) nativeCancelRAF(frameEndId);
    frameEndTs = frameTs;
    frameEndId = nativeRAF(runFrameEnd);
    return id;
}

/**
 * Runs `callback` after every other callback of each frame, so it sees the game's finished frame. null stops it.
 * A webgl canvas reads blank outside the frame it was drawn in
 *
 * @param {FrameRequestCallback|null} callback
 */
export function setFrameEnd(callback){
    frameEnd = callback;
    if (callback === null) nativeCancelRAF(frameEndId);
}

// never swapped later: the game keeps its own reference to the function (0 lookups in a match, measured)
window.requestAnimationFrame = requestFrame;
