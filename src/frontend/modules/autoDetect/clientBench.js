import { kute } from "../../client.js";
import { choose, screen, summarize, TARGET_REFRESH_MULTIPLE } from "./policy.js";

/**
 * the client's own pipeline, searched in bench processes while the game page is hidden. the orb scene screens,
 * the match decides: what wins here still has to hold in the game (index.js)
 */

/**
 * @typedef {import("./policy.js").Reading} Reading
 */

/**
 * restart-only switches the run may flip, each with a mechanism on the frame's way to the screen. the patches that
 * fix a bug (input priority, raw input, audio automation) are not candidates, they stay as the player has them
 *
 * @type {{setting: string, key: string, label: string}[]}
 */
export const PIPELINE = [
    { setting: "hardFlip", key: "hook", label: "DXGI Swapchain Hook" },
    { setting: "patchFramePacing", key: "pacing", label: "Frame Pacing" },
    { setting: "patchCanvasBufferCache", key: "canvas", label: "WebGL Buffer Cache" },
    { setting: "patchHighQoS", key: "qos", label: "Game Process at High QoS" },
];
/** copied into every bench so it runs like the client does, never flipped */
const MIRRORED = [
    { setting: "patchInputPriority", key: "inprio", fallback: true },
    { setting: "patchRawInputMovement", key: "rawinput", fallback: true },
    { setting: "patchAudioParamCoalesce", key: "coalesce", fallback: true },
    { setting: "audioFix", key: "panner", fallback: false },
    { setting: "uncapFps", key: "uncap", fallback: true },
];
/** one bench process: cef start, settle, 2 s sample, exit. the host gives up after 15 */
const PROCESS_TIMEOUT_MS = 20000;
const CAP_CYCLE_TIMEOUT_MS = 70000;
const CAP_SAMPLE_MS = 1500;
/** the scene's load may move this far from its default to reach the PC's target rate */
const LOAD_RANGE = [0.25, 16];
/** a first reading's verdict in the report's words */
const SCREENED = { contender: "better", same: "not better", worse: "worse", failed: "failed" };

/**
 * @typedef {Record<string, boolean>} Pipeline setting id -> on
 */

/**
 * @return {Pipeline} what the client runs right now
 */
export function currentPipeline(){
    return Object.fromEntries(PIPELINE.map((entry) => [entry.setting, kute.settings.data[entry.setting] !== false]));
}

/**
 * @param {Pipeline} pipeline
 * @param {string} common keys every bench of this run shares (hz, load)
 * @return {string}
 */
function configFor(pipeline, common){
    const flips = PIPELINE.map((entry) => `${entry.key}=${pipeline[entry.setting] ? 1 : 0}`);
    const mirrored = MIRRORED.map((entry) => `${entry.key}=${(kute.settings.data[entry.setting] ?? entry.fallback) ? 1 : 0}`);
    const limiter = `limiter=${kute.settings.data.patchFrameLimiter === false ? "hook" : "viz"}`;
    return [...flips, ...mirrored, limiter, common].filter((part) => part !== "").join(",");
}

/**
 * @param {any} stats FrameStats of the bench page
 * @param {any} otherTasks
 * @return {Reading}
 */
function readingOf(stats, otherTasks){
    const number = (/** @type {unknown} */ value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    return {
        fps: number(stats?.fps),
        p50: number(stats?.p50),
        p99: number(stats?.p99),
        maxMs: number(stats?.maxMs),
        stallMs: number(stats?.stallMs),
        taskP99: number(otherTasks?.p99),
        // no mouse in a bench process
        inputP99: null,
        invalid: !stats || !(stats.fps > 0),
    };
}

let lastRun = 0;

/**
 * runs the configs in bench processes, one after the other. the reply carries the run id, so a matrix that was
 * cancelled or timed out can never answer for a later one
 *
 * @param {string[]} configs
 * @param {number} timeoutMs
 * @return {Promise<any[]|null>} raw results in order, null on timeout or cancel
 */
function matrix(configs, timeoutMs){
    const run = Date.now() * 100 + (++lastRun % 100);
    return new Promise((resolve) => {
        const pending = { timer: 0 };
        /** @param {MessageEvent} event */
        const handler = (event) => {
            if (event.data?.benchMatrix === undefined || event.data.benchRun !== run) return;
            clearTimeout(pending.timer);
            window.chrome.webview.removeEventListener("message", handler);
            resolve(event.data.cancelled ? null : event.data.benchMatrix);
        };
        pending.timer = setTimeout(() => {
            window.chrome.webview.removeEventListener("message", handler);
            window.chrome.webview.postMessage("bench-cancel");
            resolve(null);
        }, timeoutMs);
        window.chrome.webview.addEventListener("message", handler);
        window.chrome.webview.postMessage(`run-bench-matrix ${run} ${JSON.stringify(configs)}`);
    });
}

export function cancel(){
    window.chrome.webview.postMessage("bench-cancel");
}

/**
 * @typedef {object} PipelineRow one candidate of the search, for the report
 * @property {string} id "current", a setting id, or "combined"
 * @property {string} label
 * @property {Pipeline} pipeline
 * @property {Reading[]} readings
 * @property {string} outcome "current", "not better", "worse", "better", "failed"
 */

/**
 * @typedef {object} PipelineSearch
 * @property {Pipeline} winner the pipeline in use when nothing beat it
 * @property {boolean} changed
 * @property {import("./policy.js").Metric|null} decidedBy
 * @property {PipelineRow[]} rows
 * @property {string} common bench keys of this run, for the cap cycle
 * @property {number|null} capacity uncapped fps of the winner on the calibrated scene
 */

/**
 * every flip once against the pipeline in use, a second reading for the ones that look better, then the improving
 * flips combined. not a full factorial, the same way the game settings get measured
 *
 * @param {{hz: number, hybrid: boolean, progress: (text: string, share: number) => void, cancelled: () => boolean}} options
 * @return {Promise<PipelineSearch|null>} null when cancelled or the bench did not run
 */
export async function searchPipeline({ hz, progress, cancelled }){
    const current = currentPipeline();
    progress("Testing the client (1 of 4)", 0);
    // the scene at its default load says how fast this PC runs it, then the load moves the scene to the PC's target rate
    const calibration = await matrix([configFor(current, `hz=${hz}`)], PROCESS_TIMEOUT_MS);
    const calibrated = readingOf(calibration?.[0]?.page?.stats, calibration?.[0]?.page?.otherTasks);
    if (cancelled() || calibrated.invalid || calibrated.fps === null) return null;
    const load = calibration?.[0]?.page?.load;
    const factor = Math.min(LOAD_RANGE[1], Math.max(LOAD_RANGE[0], calibrated.fps / (hz * TARGET_REFRESH_MULTIPLE)));
    const common = `hz=${hz},draws=${Math.round(load.draws * factor)},cpu=${Math.round(load.cpuIterations * factor)}`;

    const flips = PIPELINE.map((entry) => ({ entry, pipeline: { ...current, [entry.setting]: !current[entry.setting] } }));
    progress("Testing the client (2 of 4)", 0.15);
    // incumbent first and last, its two readings bracket the flips and give the spread
    const first = await matrix([configFor(current, common), ...flips.map((flip) => configFor(flip.pipeline, common)), configFor(current, common)], PROCESS_TIMEOUT_MS * (flips.length + 2));
    if (cancelled() || first === null) return null;
    const read = (/** @type {any} */ result) => readingOf(result?.page?.stats, result?.page?.otherTasks);
    const incumbentReadings = [read(first[0]), read(first[first.length - 1])];
    const base = summarize(incumbentReadings);

    /** @type {PipelineRow[]} */
    const rows = [{ id: "current", label: "As you had it", pipeline: current, readings: incumbentReadings, outcome: "current" }];
    const contenders = [];
    for (const [index, flip] of flips.entries()){
        const reading = read(first[index + 1]);
        const verdict = reading.invalid ? "failed" : screen(reading, base);
        const label = `${flip.entry.label} ${flip.pipeline[flip.entry.setting] ? "on" : "off"}`;
        /** @type {PipelineRow} */
        const row = { id: flip.entry.setting, label, pipeline: flip.pipeline, readings: [reading], outcome: SCREENED[verdict] };
        rows.push(row);
        if (verdict === "contender") contenders.push(row);
    }
    if (contenders.length === 0) return { winner: current, changed: false, decidedBy: null, rows, common, capacity: base.fps.median };

    progress("Testing the client (3 of 4)", 0.55);
    const second = await matrix([...contenders.map((row) => configFor(row.pipeline, common)), configFor(current, common)], PROCESS_TIMEOUT_MS * (contenders.length + 1));
    if (cancelled() || second === null) return null;
    for (const [index, row] of contenders.entries()) row.readings.push(read(second[index]));
    incumbentReadings.push(read(second[second.length - 1]));

    let choice = choose({ id: "current", readings: incumbentReadings }, contenders.map((row) => ({ id: row.id, readings: row.readings })));
    for (const row of contenders){
        const judged = choice.judged.find((entry) => entry.id === row.id);
        row.outcome = "not better";
        if (judged?.rejected) row.outcome = "worse";
        else if (judged?.decidedBy) row.outcome = "better";
    }
    const improving = contenders.filter((row) => row.outcome === "better");
    let winner = rows.find((row) => row.id === choice.winner) ?? rows[0];

    // every flip that helped on its own, together: verified like any other candidate, a pair can also cancel out
    if (improving.length > 1){
        progress("Testing the client (4 of 4)", 0.8);
        const pipeline = { ...current };
        for (const row of improving) pipeline[row.id] = row.pipeline[row.id];
        const combined = await matrix([configFor(pipeline, common), configFor(current, common), configFor(pipeline, common)], PROCESS_TIMEOUT_MS * 3);
        if (cancelled() || combined === null) return null;
        incumbentReadings.push(read(combined[1]));
        /** @type {PipelineRow} */
        const row = { id: "combined", label: improving.map((entry) => entry.label).join(" and "), pipeline, readings: [read(combined[0]), read(combined[2])], outcome: "not better" };
        rows.push(row);
        const together = choose({ id: winner.id, readings: winner.readings }, [{ id: row.id, readings: row.readings }]);
        const againstCurrent = choose({ id: "current", readings: incumbentReadings }, [{ id: row.id, readings: row.readings }]);
        if (together.changed && againstCurrent.changed){
            row.outcome = "better";
            winner = row;
            choice = againstCurrent;
        }
    }
    const changed = winner.id !== "current";
    return {
        winner: winner.pipeline,
        changed,
        decidedBy: changed ? choice.decidedBy : null,
        rows,
        common,
        capacity: summarize(winner.readings).fps.median,
    };
}

/**
 * every cap on one pipeline, in one bench process (the limiter reads the cap live), twice over
 *
 * @param {{pipeline: Pipeline, common: string, caps: number[], cancelled: () => boolean}} options caps: 0 = uncapped
 * @return {Promise<Map<number, Reading[]>|null>} readings per cap, null when cancelled or the bench did not run
 */
export async function measureCaps({ pipeline, common, caps, cancelled }){
    const config = `${configFor(pipeline, common)},caps=${caps.join(".")},rounds=2,ms=${CAP_SAMPLE_MS}`;
    const result = await matrix([config], CAP_CYCLE_TIMEOUT_MS);
    const samples = result?.[0]?.page?.caps;
    if (cancelled() || !Array.isArray(samples)) return null;
    /** @type {Map<number, Reading[]>} */
    const readings = new Map(caps.map((cap) => [cap, []]));
    for (const sample of samples) readings.get(Number(sample.cap))?.push(readingOf(sample.stats, sample.otherTasks));
    return readings;
}
