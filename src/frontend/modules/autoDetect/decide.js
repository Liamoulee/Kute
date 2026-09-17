// The decision of auto-detect, free of DOM and game access so it can change through the hot update
// channel on its own. It knows no presets and no kinds of PC: every game setting it changes is one that
// was measured to help on this PC. Background and the data behind the constants: _docs/auto-detect-plan.md.

/** Frames per second the game should hold, as a multiple of the display's refresh rate. */
export const TARGET_REFRESH_MULTIPLE = 3;
/**
 * The test match is empty and the PC is cool, a real match is neither. A laptop was measured to lose a
 * quarter to heat within a minute, so the goal has to be cleared by that much.
 */
export const HEADROOM = 1.25;
/** Neighbouring samples agree within one to four percent in a test match. Less than five is not worth a visual loss either. */
export const SIGNIFICANT_SETTING = 1.05;
/** Half the pixels has to gain this much before the graphics card counts as the limit. */
export const SIGNIFICANT_RESOLUTION = 1.1;
/** Auto-detect never lowers the resolution scale below this. */
export const MIN_RESOLUTION = 0.75;

/**
 * @typedef {object} MeasuredSetting
 * @property {string} id
 * @property {string} label
 * @property {string} current The value before the run
 * @property {string} cheap
 * @property {number|null} gain Frame rate with the cheap value divided by the rate with the other, null when not measured
 * @property {boolean} steady Whether the samples around the measurement agreed
 * @property {string} [note] Why there is no usable number
 */

/**
 * @typedef {object} Measurements
 * @property {number} baseFps At the player's current settings
 * @property {number} p50 Median frame time, ms
 * @property {number} p99
 * @property {number} presentFps Frames reaching the swap chain, 0 without the hook
 * @property {number|null} halfResolutionGain Frame rate at half the resolution scale divided by the normal one
 * @property {MeasuredSetting[]} settings
 */

/**
 * @typedef {object} Facts
 * @property {number} hz Refresh rate of the display that hosts the window
 * @property {boolean} onBattery
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
 * @property {string} reason
 */

/**
 * @typedef {object} Plan
 * @property {number} goal
 * @property {number} needed The goal with headroom, what the test match has to show
 * @property {boolean} holds Whether the PC already clears it
 * @property {"cpu"|"gpu"|"unknown"} regime What limits the frame rate
 * @property {boolean} healthy False when frames pile up behind the swap chain
 * @property {number} predictedFps After the game changes, from the measured gains
 * @property {boolean} tuneResolution Whether the caller may lower the resolution scale afterwards (by measuring)
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
 * @param {Measurements} measured
 * @param {Facts} facts
 * @return {Plan}
 */
export function decide(measured, facts){
    const goal = facts.hz * TARGET_REFRESH_MULTIPLE;
    const needed = goal * HEADROOM;
    const holds = measured.baseFps >= needed;

    /** @type {Plan["regime"]} */
    let regime = "unknown";
    if (measured.halfResolutionGain !== null) regime = measured.halfResolutionGain >= SIGNIFICANT_RESOLUTION ? "gpu" : "cpu";

    // the signature of frames piling up behind the swap chain: the loop counts far more frames than get
    // presented, or they arrive in bursts with a stall after each (p99 many times the median)
    const flooding = measured.presentFps > 0 && measured.presentFps < measured.baseFps * 0.6;
    const bursting = measured.p99 > measured.p50 * 8 && measured.p99 > 1000 / facts.hz;
    const healthy = !flooding && !bursting;

    /** @type {Change[]} */
    const changes = [];

    // quality is only traded while the goal is missed, and only for what was measured to pay on this PC:
    // the biggest gain first, until the measured gains add up to the goal
    let predictedFps = measured.baseFps;
    if (!holds){
        const helpful = measured.settings
            .filter((setting) => setting.gain !== null && setting.steady && setting.current !== setting.cheap && setting.gain >= SIGNIFICANT_SETTING)
            .sort((a, b) => (b.gain ?? 0) - (a.gain ?? 0));
        for (const setting of helpful){
            if (predictedFps >= needed) break;
            const gain = setting.gain ?? 1;
            predictedFps *= gain;
            changes.push({
                scope: "game",
                id: setting.id,
                label: setting.label,
                value: setting.cheap,
                reason: `measured +${Math.round((gain - 1) * 100)} %`,
            });
        }
    }

    // Krunker's frame cap spins inside the frame loop. Kute's limiter holds the same rate with an idle main thread
    let fpsLimit = facts.gameFpsLimit;
    if (facts.gameFrameCap > 0){
        changes.push({ scope: "game", id: "updateRate", label: "Frame Cap (game)", value: "0", reason: "replaced by Kute's FPS limit" });
        if (fpsLimit === 0) fpsLimit = roundToStep(facts.gameFrameCap);
    }
    // everything above the goal only drains the battery
    if (facts.onBattery && (fpsLimit === 0 || fpsLimit > goal)) fpsLimit = roundToStep(goal);
    // rescue for a pipeline that still floods: hold the loop a bit below what actually gets presented
    if (!healthy && fpsLimit === 0) fpsLimit = roundToStep((measured.presentFps || measured.baseFps) * 0.9);
    if (fpsLimit !== facts.gameFpsLimit){
        let reason = "moved over from the game's frame cap";
        if (!healthy) reason = "frames were piling up";
        else if (facts.onBattery) reason = "on battery";
        changes.push({ scope: "client", id: "gameFpsLimit", label: "FPS Limit", value: fpsLimit, reason });
    }

    // CPU throttling pauses the main thread in bursts, which is what causes the lag spikes people report with it
    if (facts.throttle > 1) changes.push({ scope: "client", id: "throttle", label: "CPU Throttling", value: 1, reason: "causes lag spikes" });

    return {
        goal,
        needed,
        holds,
        regime,
        healthy,
        predictedFps,
        tuneResolution: !holds && regime === "gpu" && predictedFps < needed,
        changes,
    };
}
