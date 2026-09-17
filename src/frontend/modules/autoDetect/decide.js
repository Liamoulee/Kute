import { TIERS } from "./gameSettings.js";

// The decision rules of auto-detect, kept free of DOM and game access so they can change through the
// hot update channel (and be reasoned about) on their own. Background: _docs/auto-detect-plan.md.

/** Frames per second the game should hold, as a multiple of the display's refresh rate. */
export const TARGET_REFRESH_MULTIPLE = 3;
/** A probe has to move the frame rate by this factor to count, below it is measuring noise. */
export const SIGNIFICANT = 1.15;
/** Auto-detect never lowers the resolution scale below this. */
export const MIN_RESOLUTION = 0.75;
/**
 * A match runs at least this much faster than the menu in front of it: the menu's own interface costs main
 * thread time. Measured 1.5 to 2.2 on a desktop and 1.7 on a Tiger Lake laptop, the low end is used.
 */
export const MENU_TO_MATCH = 1.5;
/**
 * What a laptop still delivers once it is warm, as a share of what it shows in the first seconds.
 * A Tiger Lake laptop fell from 205 to 150 frames per second within a minute of an empty match.
 */
export const LAPTOP_SUSTAINED = 0.75;

/**
 * @typedef {object} Measurements
 * @property {number} baseFps At the player's current settings
 * @property {number} lowResFps At half the resolution scale
 * @property {number|null} highResFps At twice the resolution scale, null when it was not measured
 * @property {number} p50 Median frame time at the current settings, ms
 * @property {number} p99
 * @property {number} presentFps Frames reaching the swap chain, 0 without the hook
 */

/**
 * @typedef {object} Facts
 * @property {number} hz Refresh rate of the display that hosts the window
 * @property {boolean} onBattery
 * @property {boolean} laptop
 * @property {boolean} inMatch Whether the samples come from a match, otherwise from the menu
 * @property {(id: string) => string|null} readGameSetting
 * @property {number} throttle Kute's CPU throttle setting
 * @property {number} gameFpsLimit Kute's FPS limit setting
 * @property {number} gameFrameCap Krunker's own frame cap setting
 */

/**
 * @typedef {object} Change
 * @property {"game"|"client"} scope
 * @property {string} id
 * @property {string} label
 * @property {string|number|boolean} value
 * @property {boolean} [needsReload]
 */

/**
 * @typedef {object} Plan
 * @property {"cpu"|"gpu"} regime What limits the frame rate right now
 * @property {boolean} gpuHeadroom Whether the GPU still kept up at four times the pixels
 * @property {boolean} healthy False when frames pile up behind the swap chain
 * @property {number} target
 * @property {number} expectedFps What the PC should hold in a long match, the number the goal is compared with
 * @property {number} tiers How many tiers of game settings get their cheap values
 * @property {boolean} tuneResolution Whether the resolution scale may be lowered afterwards (measured by the caller)
 * @property {Change[]} changes
 */

/**
 * @param {number} fps
 * @return {number} Rounded to the limiter's step
 */
function roundToStep(fps){
    return Math.max(5, Math.round(fps / 5) * 5);
}

/**
 * From a few seconds of samples to what the PC holds in a long match.
 *
 * @param {number} fps
 * @param {{inMatch: boolean, laptop: boolean}} facts
 * @return {number}
 */
export function expectedFps(fps, facts){
    return fps * (facts.inMatch ? 1 : MENU_TO_MATCH) * (facts.laptop ? LAPTOP_SUSTAINED : 1);
}

/**
 * @param {Measurements} measured
 * @param {Facts} facts
 * @return {Plan}
 */
export function decide(measured, facts){
    const target = facts.hz * TARGET_REFRESH_MULTIPLE;
    const gpuBound = measured.lowResFps / Math.max(1, measured.baseFps) >= SIGNIFICANT;
    const gpuHeadroom = !gpuBound && measured.highResFps !== null && measured.baseFps / Math.max(1, measured.highResFps) < SIGNIFICANT;

    // the signature of frames piling up behind the swap chain: the loop counts far more frames than get
    // presented, or they arrive in bursts with a stall after each (p99 many times the median)
    const flooding = measured.presentFps > 0 && measured.presentFps < measured.baseFps * 0.6;
    const bursting = measured.p99 > measured.p50 * 8 && measured.p99 > 1000 / facts.hz;
    const healthy = !flooding && !bursting;

    /** @type {Change[]} */
    const changes = [];

    // how far the PC is from the target decides how many tiers go, the menu cannot show what most of them cost
    const expected = expectedFps(measured.baseFps, facts);
    const deficit = target / Math.max(1, expected);
    let tiers = 0;
    if (deficit > 2.5) tiers = 4;
    else if (deficit > 1.7) tiers = 3;
    else if (deficit > 1.3) tiers = 2;
    else if (deficit > 1) tiers = 1;

    for (const tier of TIERS.slice(0, tiers)){
        for (const setting of tier.settings){
            if (facts.readGameSetting(setting.id) === String(setting.cheap)) continue;
            changes.push({ scope: "game", id: setting.id, label: setting.label, value: setting.cheap, needsReload: setting.needsReload });
        }
    }

    // Krunker's frame cap spins inside the frame loop. Kute's limiter holds the same rate with an idle main thread
    let fpsLimit = facts.gameFpsLimit;
    if (facts.gameFrameCap > 0){
        changes.push({ scope: "game", id: "updateRate", label: "Frame Cap (game)", value: "0" });
        if (fpsLimit === 0) fpsLimit = roundToStep(facts.gameFrameCap);
    }
    // everything above the target only drains the battery
    if (facts.onBattery && (fpsLimit === 0 || fpsLimit > target)) fpsLimit = roundToStep(target);
    // rescue for a pipeline that still floods: hold the loop a bit below what actually gets presented
    if (!healthy && fpsLimit === 0) fpsLimit = roundToStep((measured.presentFps || measured.baseFps) * 0.9);
    if (fpsLimit !== facts.gameFpsLimit) changes.push({ scope: "client", id: "gameFpsLimit", label: "FPS Limit", value: fpsLimit });

    // CPU throttling pauses the main thread in bursts, which is what causes the lag spikes people report with it
    if (facts.throttle > 1) changes.push({ scope: "client", id: "throttle", label: "CPU Throttling", value: 1 });

    return {
        regime: gpuBound ? "gpu" : "cpu",
        gpuHeadroom,
        healthy,
        target,
        expectedFps: expected,
        tiers,
        tuneResolution: gpuBound && deficit > 1,
        changes,
    };
}
