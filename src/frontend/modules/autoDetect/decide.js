/** Frames per second the game should hold, as a multiple of the display's refresh rate. */
export const TARGET_REFRESH_MULTIPLE = 3;
/**
 * The test match is empty and the PC is cool, a real match is neither. A laptop was measured to lose a
 * quarter to heat within a minute, so the goal has to be cleared by that much.
 */
export const HEADROOM = 1.25;
/** Neighbouring samples agree within one to four percent in a test match. Less than five is not worth a visual loss either. */
export const SIGNIFICANT_SETTING = 1.05;
/** Half the resolution scale (a quarter of the pixels) has to gain this much before the graphics card counts as the limit. */
export const SIGNIFICANT_RESOLUTION = 1.1;
/** Auto-detect never lowers the resolution scale below this. */
export const MIN_RESOLUTION = 0.75;
/** no limit this module sets goes below this or below the refresh rate */
const LOWEST_LIMIT = 60;
/** a present count below this share of the game's frame rate is a broken reading, not a measurement */
const IMPLAUSIBLE_PRESENT_SHARE = 0.1;

/** One client configuration has to beat another by this much in its slowest frames before it replaces it. */
export const SIGNIFICANT_CLIENT = 1.1;
/**
 * ... and by this share of one refresh interval of the display (1.4 ms at 180 Hz, 4.2 ms at 60 Hz), never less
 * than half a millisecond. The client test is there to find a configuration that stutters on this PC, which
 * shows as several milliseconds. Below a quarter of a refresh the same picture reaches the screen either way:
 * at 2000 frames per second the hook measures 1.0 ms against 0.7 ms without it, which reads as "30 % smoother"
 * and means nothing, while the hook is what keeps the input latency short and the FPS limit exact.
 */
export const SIGNIFICANT_CLIENT_REFRESH_SHARE = 0.25;
export const SIGNIFICANT_CLIENT_MIN_MS = 0.5;
/**
 * Between configurations that are equally smooth, more frames only count from a quarter more. CPU throttling costs
 * 40 %, that is a reason to switch. The hook costs 3 to 15 % at 2000 frames per second from one run to the next,
 * that is not: it would flip with the weather, and it buys the short input latency and the exact FPS limit.
 */
export const SIGNIFICANT_CLIENT_FPS = 1.25;

/**
 * A client configuration as one bench process measured it.
 *
 * @typedef {object} ClientResult
 * @property {string} config What was started, e.g. "hook=0,limit=auto"
 * @property {string} label
 * @property {boolean} hook The DXGI swapchain hook
 * @property {boolean} capped
 * @property {boolean} throttled
 * @property {number} fps Average frames per second, 0 when the process failed
 * @property {number} p99 Frame time of the slowest 1 % of frames in ms, what stutter feels like
 * @property {number} low The same as frames per second (1000 / p99), for showing it
 * @property {number} [p50] The rest is only there for the report: median and worst frame time in ms,
 * @property {number} [max]
 * @property {{p50: number, p99: number, max: number}|null} [present] the hook's own present intervals in ms,
 * @property {number} [taskDelayP99] how long other main thread work waited in ms,
 * @property {number} [limit] and the FPS cap that "limit=auto" turned into
 */

/**
 * @typedef {object} ClientPlan
 * @property {ClientResult|null} current The measured configuration that matches the player's settings
 * @property {ClientResult|null} best
 * @property {boolean} change Whether best is clearly better than current
 */

/**
 * Ranks the measured client configurations. The slowest frames decide (a high average with stalls in it is
 * the old GPU bottleneck bug), the average breaks ties, and between equals the one with fewer restrictions
 * wins (the list is ordered that way).
 *
 * @param {ClientResult[]} results
 * @param {{hardFlip: boolean, capped: boolean, throttled: boolean}} settings
 * @param {number} hz Refresh rate of the display that hosts the window
 * @return {ClientPlan}
 */
export function decideClient(results, settings, hz){
    const significantMs = Math.max(SIGNIFICANT_CLIENT_MIN_MS, (1000 / hz) * SIGNIFICANT_CLIENT_REFRESH_SHARE);
    // a row without frame times is not a smooth row, it is a row that failed to report: p99 defaults to 0 when
    // the bench process wrote no stats, and 0 ms beats every real measurement in the comparison below
    const usable = results.filter((result) => result.fps > 0 && result.p99 > 0 && Number.isFinite(result.p99));
    const current =
        usable.find((result) => result.hook === settings.hardFlip && result.capped === settings.capped && result.throttled === settings.throttled) ??
        usable.find((result) => result.hook === settings.hardFlip && !result.capped && !result.throttled) ??
        null;
    /**
     * @param {ClientResult} a
     * @param {ClientResult} b
     * @return {boolean} Whether a is clearly better than b
     */
    const beats = (a, b) => {
        // a cap buys evenness with frames, and it can only buy something that is missing: as long as the
        // uncapped configuration already lands every frame inside one refresh interval, the same picture
        // reaches the screen either way and the cap is pure loss. Without this rule a cap at 725 beat an
        // uncapped 1063 FPS on a PC whose slowest frames were 2.8 ms out of 5.6, and the run then applied a
        // completely different cap on top, because the one it measured came from the bench scene
        if (a.capped && !b.capped && b.p99 <= 1000 / hz) return false;
        const smoother = a.p99 * SIGNIFICANT_CLIENT <= b.p99 && b.p99 - a.p99 >= significantMs;
        const notRougher = a.p99 <= b.p99 + significantMs;
        // more frames are only a reason while the display can still use them, so the same goal the rest of the
        // run works towards decides that. Above it the frames are free of charge and paid for with everything
        // the loser's configuration does besides counting frames: turning the hook off for 15 % of 1800 FPS on
        // a 60 Hz screen costs the exact FPS limiter, the present statistics this run judges frame pacing by,
        // and the OBS capture, and gives back nothing anybody can see. Below the goal frames are scarce and a
        // quarter more is worth having
        const framesMatter = b.fps < hz * TARGET_REFRESH_MULTIPLE;
        return smoother || (framesMatter && notRougher && a.fps >= b.fps * SIGNIFICANT_CLIENT_FPS);
    };
    // the configuration in use defends its place: another one has to clearly beat it, and the best challenger wins
    let best = current ?? usable[0] ?? null;
    for (const result of usable){
        if (best && result !== best && beats(result, best)) best = result;
    }
    return { current, best, change: Boolean(best && current && best !== current) };
}

/**
 * @typedef {object} MeasuredSetting
 * @property {string} id
 * @property {string} label
 * @property {string} current The value before the run
 * @property {string} cheap
 * @property {number|null} gain Frame rate with the cheap value divided by the rate with the other, null when not measured
 * @property {boolean} steady Whether the samples around the measurement agreed
 * @property {string} [note] Why there is no usable number
 * @property {number[]} [raw] For the report: frames per second before, with the value flipped, and after
 * @property {number} [confirmGain] The second measurement, when there was one
 */

/**
 * @typedef {object} Measurements
 * @property {number} baseFps At the player's current settings, the median of every unchanged sample of the run
 * @property {number} p50 Median frame time, ms
 * @property {number} p99
 * @property {number} presentFps Frames reaching the swap chain, 0 without the hook
 * @property {number} windowFps What the frame loop ran at in exactly the window presentFps was counted over
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
 * @property {boolean} hardFlip Kute's swapchain hook setting
 * @property {ClientResult|null} client The client configuration to switch to, null to leave the client alone
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
 * An FPS limit this module may set. Never below what the display shows: whatever a measurement says, a cap under
 * the refresh rate is never the cure, and a broken reading must not be able to turn the game into a slideshow
 * (a stale present counter once read 3, and the run set a limit of 5).
 *
 * Rounding to the limiter's step happens first and the floor is applied after it, never the other way round:
 * 72 Hz rounds to 70, which is exactly the cap under the refresh rate this is meant to rule out.
 *
 * @param {number} fps
 * @param {number} hz
 * @return {number}
 */
function limitFor(fps, hz){
    const floor = Math.max(hz, LOWEST_LIMIT);
    return Math.max(roundToStep(Math.max(fps, floor)), Math.ceil(floor / 5) * 5);
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
    // presented, or they arrive in bursts with a stall after each (p99 many times the median).
    // presentFps is 0 when the hook gave no count for the measured window (off, or not answering), and a count
    // that is a tiny fraction of the game's rate is a broken reading, not a PC: the worst real case measured
    // was 43 presents for 255 frames, a sixth.
    // Both sides of this ratio have to come from the same window. baseFps is the median of samples taken over
    // the whole run, and the game warms up inside it (1340 frames per second in the first seconds against 1900
    // at the end of one run), so comparing the early present count with it reads as flooding on a healthy PC
    const windowFps = measured.windowFps > 0 ? measured.windowFps : measured.baseFps;
    const plausible = measured.presentFps >= windowFps * IMPLAUSIBLE_PRESENT_SHARE;
    const flooding = plausible && measured.presentFps < windowFps * 0.6;
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
        if (fpsLimit === 0) fpsLimit = limitFor(facts.gameFrameCap, facts.hz);
    }

    if (facts.onBattery && (fpsLimit === 0 || fpsLimit > goal)) fpsLimit = roundToStep(goal);

    if (!healthy && fpsLimit === 0) fpsLimit = limitFor((flooding ? measured.presentFps : measured.baseFps) * 0.9, facts.hz);

    if (fpsLimit !== facts.gameFpsLimit){
        let reason = "moved over from the game's frame cap";
        if (!healthy) reason = "frames were piling up";
        else if (facts.onBattery) reason = "on battery";
        changes.push({ scope: "client", id: "gameFpsLimit", label: "FPS Limit", value: fpsLimit, reason });
    }

    if (facts.client){
        const reason = `slowest frames measured at ${facts.client.p99.toFixed(1)} ms`;
        if (facts.client.hook !== facts.hardFlip){
            changes.push({ scope: "client", id: "hardFlip", label: "DXGI Swapchain Hook", value: facts.client.hook, reason: `${reason}, needs a restart` });
        }
        if (facts.client.capped && fpsLimit === 0){
            changes.push({ scope: "client", id: "gameFpsLimit", label: "FPS Limit", value: limitFor(predictedFps * 0.9, facts.hz), reason });
        }
        if (facts.client.throttled !== facts.throttle > 1){
            changes.push({ scope: "client", id: "throttle", label: "CPU Throttling", value: facts.client.throttled ? 1.5 : 1, reason });
        }
    }

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
