export const TARGET_REFRESH_MULTIPLE = 3;
/** margin over the goal, test match is empty and cool, a real one isn't */
export const HEADROOM = 1.25;
/** min gain for a setting to be worth a visual loss (samples jitter 1-4 %) */
export const SIGNIFICANT_SETTING = 1.05;
/** half res scale has to gain this much before we call it gpu bound */
export const SIGNIFICANT_RESOLUTION = 1.1;
export const MIN_RESOLUTION = 0.75;
/** no limit we set goes below this or below the refresh rate */
const LOWEST_LIMIT = 60;
/** present count below this share of the game's fps is a broken reading */
const IMPLAUSIBLE_PRESENT_SHARE = 0.1;

/** a client config has to beat another by this much in p99 to replace it */
export const SIGNIFICANT_CLIENT = 1.1;
/** ... and by this share of a refresh interval, at least SIGNIFICANT_CLIENT_MIN_MS */
export const SIGNIFICANT_CLIENT_REFRESH_SHARE = 0.25;
export const SIGNIFICANT_CLIENT_MIN_MS = 0.5;
/** between equally smooth configs, more fps only counts from +25 % */
export const SIGNIFICANT_CLIENT_FPS = 1.25;

/**
 * @typedef {object} ClientResult
 * @property {string} config e.g. "hook=0,limit=auto"
 * @property {string} label
 * @property {boolean} hook DXGI swapchain hook
 * @property {boolean} capped
 * @property {boolean} throttled
 * @property {number} fps avg fps, 0 when the process failed
 * @property {number} p99 frame time of the slowest 1 % in ms
 * @property {number} low 1000 / p99, for display
 * @property {number} [p50] report only from here on: median frame time ms
 * @property {number} [max]
 * @property {{p50: number, p99: number, max: number}|null} [present] hook's present intervals in ms
 * @property {number|null} [taskDelayP99] main thread task delay in ms, null when no probe ran
 * @property {number} [limit] the cap "limit=auto" turned into
 */

/**
 * @typedef {object} ClientPlan
 * @property {ClientResult|null} current config matching the player's settings
 * @property {ClientResult|null} best
 * @property {boolean} change whether best clearly beats current
 */

/**
 * ranks the measured client configs, p99 first, avg fps breaks ties
 *
 * @param {ClientResult[]} results
 * @param {{hardFlip: boolean, capped: boolean, throttled: boolean}} settings
 * @param {number} hz refresh rate of the window's display
 * @return {ClientPlan}
 */
export function decideClient(results, settings, hz){
    const significantMs = Math.max(SIGNIFICANT_CLIENT_MIN_MS, (1000 / hz) * SIGNIFICANT_CLIENT_REFRESH_SHARE);
    // p99 is 0 when the bench wrote no stats, that would beat every real row
    const usable = results.filter((result) => result.fps > 0 && result.p99 > 0 && Number.isFinite(result.p99));
    const current =
        usable.find((result) => result.hook === settings.hardFlip && result.capped === settings.capped && result.throttled === settings.throttled) ??
        usable.find((result) => result.hook === settings.hardFlip && !result.capped && !result.throttled) ??
        null;
    /**
     * @param {ClientResult} a
     * @param {ClientResult} b
     * @return {boolean} whether a clearly beats b
     */
    const beats = (a, b) => {
        // a cap is pure loss while uncapped already lands every frame inside one refresh
        if (a.capped && !b.capped && b.p99 <= 1000 / hz) return false;
        const smoother = a.p99 * SIGNIFICANT_CLIENT <= b.p99 && b.p99 - a.p99 >= significantMs;
        const notRougher = a.p99 <= b.p99 + significantMs;
        const framesMatter = b.fps < hz * TARGET_REFRESH_MULTIPLE;
        return smoother || (framesMatter && notRougher && a.fps >= b.fps * SIGNIFICANT_CLIENT_FPS);
    };
    // current config defends its place, best challenger wins
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
 * @property {string} current value before the run
 * @property {string} cheap
 * @property {number|null} gain fps with cheap / fps with the other, null when not measured
 * @property {boolean} steady whether the samples around it agreed
 * @property {string} [note] why there's no usable number
 * @property {number[]} [raw] report only: fps before, flipped, after
 * @property {number} [confirmGain] second measurement, if any
 */

/**
 * @typedef {object} Measurements
 * @property {number} baseFps median of every unchanged sample of the run
 * @property {number} p50 median frame time, ms
 * @property {number} p99
 * @property {number} presentFps frames reaching the swap chain, 0 without the hook
 * @property {number} windowFps loop fps over the same window presentFps was counted in
 * @property {number|null} halfResolutionGain fps at half res scale / fps at normal
 * @property {MeasuredSetting[]} settings
 */

/**
 * @typedef {object} Facts
 * @property {number} hz refresh rate of the window's display
 * @property {boolean} onBattery
 * @property {number} throttle
 * @property {number} gameFpsLimit
 * @property {number} gameFrameCap krunker's own frame cap
 * @property {boolean} hardFlip
 * @property {ClientResult|null} client config to switch to, null to leave the client alone
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
 * @property {number} needed goal with headroom
 * @property {boolean} holds whether the PC already clears it
 * @property {"cpu"|"gpu"|"unknown"} regime what limits the fps
 * @property {boolean} healthy false when frames pile up behind the swap chain
 * @property {number} predictedFps after the game changes, from the measured gains
 * @property {boolean} tuneResolution whether the caller may lower res scale afterwards
 * @property {Change[]} changes
 */

/**
 * @param {number} fps
 * @return {number} rounded to the limiter's step
 */
function roundToStep(fps){
    return Math.max(5, Math.round(fps / 5) * 5);
}

/**
 * fps limit we may set, never below the refresh rate (round first, floor after)
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

    // frames piling up: far fewer presents than loop frames, or bursts with a stall after each.
    // both sides of the ratio must come from the same window, the game warms up during the run
    const windowFps = measured.windowFps > 0 ? measured.windowFps : measured.baseFps;
    const plausible = measured.presentFps >= windowFps * IMPLAUSIBLE_PRESENT_SHARE;
    const flooding = plausible && measured.presentFps < windowFps * 0.6;
    const bursting = measured.p99 > measured.p50 * 8 && measured.p99 > 1000 / facts.hz;
    const healthy = !flooding && !bursting;

    /** @type {Change[]} */
    const changes = [];

    // only trade quality while the goal is missed, biggest measured gain first
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

    // krunker's frame cap busy-waits in the loop, ours idles
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
        // uncapped won, drop the cap unless something above already set the limit
        if (!facts.client.capped && fpsLimit > 0 && fpsLimit === facts.gameFpsLimit){
            changes.push({ scope: "client", id: "gameFpsLimit", label: "FPS Limit", value: 0, reason: `${reason} without a cap` });
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
