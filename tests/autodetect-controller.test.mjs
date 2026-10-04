import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";
import * as policy from "../src/frontend/modules/autoDetect/policy.js";
import * as decisions from "../src/frontend/modules/autoDetect/decide.js";
import { FrameRecorder } from "../src/frontend/modules/autoDetect/metrics.js";

/**
 * The real `AutoDetect.run()` with simulated readings: what it keeps, what it puts back and what it tells the player.
 * The controller's source runs in a VM with its imports replaced by the stand-ins below, the decisions are the real
 * policy.js and decide.js. Every case here was a wrong outcome once (release review 2026-10-02).
 */

const controller = fs.readFileSync(new URL("../src/frontend/modules/autoDetect/index.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace("export function loggedIn", "function loggedIn")
    .replace(/const autoDetect = new AutoDetect\(\);[\s\S]*$/, "globalThis.AutoDetect = AutoDetect;");

/**
 * @typedef {Record<string, any>} Fixture a reading as sample.js would return it
 */

/**
 * @param {number} fps
 * @param {Fixture} [fields]
 * @return {Fixture} a clean reading at this frame rate
 */
const reading = (fps, fields = {}) => ({
    fps, p50: 1000 / fps, p99: 1000 / fps + 0.5, maxMs: 1000 / fps + 1, inputP99: 1000 / fps + 0.5, taskP99: 2, stallMs: 0, invalid: false, ...fields,
});

/**
 * @param {number} fastCount frames of 5 ms
 * @param {number} slowCount
 * @param {number} slowGap ms
 * @return {Fixture} a reading whose frame numbers come from the real FrameRecorder
 */
function recorded(fastCount, slowCount, slowGap){
    const frames = new FrameRecorder();
    let time = 0;
    frames.frame(time);
    for (const gap of [...Array(fastCount).fill(5), ...Array(slowCount).fill(slowGap)]) frames.frame(time += gap);
    return { ...frames.stats(1000 / 360), taskP99: 20, inputP99: 5.5, invalid: false };
}

/**
 * @typedef {object} Case
 * @property {(state: {phase: string, cap: number, game: Record<string, string>}) => Fixture} read the reading for this moment
 * @property {number} [cap] the player's fps limit, 0 = none
 * @property {number} [hz]
 * @property {boolean} [mobile] a laptop
 * @property {boolean} [quality] the game has one setting to trade
 * @property {Record<string, any>} [carry] the first half of a run, to continue after its restart
 * @property {string} [cancelAt] the phase in which the player presses escape
 * @property {(cap: number) => number} [presentMs] the hook's present interval at a limit
 */

/**
 * @param {Case} options
 * @return {Promise<{result: any, client: Record<string, any>, game: Record<string, string>}>} what the run returned and left behind
 */
async function run({ read, cap = 500, hz = 60, mobile = true, quality = false, carry, cancelAt, presentMs }){
    let clock = 0;
    let phase = "";
    const pipeline = { hardFlip: true };
    /** @type {Record<string, any>} */
    const client = { gameFpsLimit: cap, throttle: 1, ...pipeline };
    /** @type {Record<string, string>} */
    const gameValues = { updateRate: "0", resolution: "1", ...(quality ? { postProcessing: "true" } : {}) };
    const game = {
        GAME_FRAME_CAP: "updateRate",
        RESOLUTION: "resolution",
        ALL_IDS: Object.keys(gameValues),
        SETTINGS: quality ? [{ id: "postProcessing", label: "Post Processing", cheap: false }] : [],
        opposite: (/** @type {string} */ value) => (value === "true" ? "false" : "true"),
        read: (/** @type {string} */ id) => gameValues[id],
        write: (/** @type {string} */ id, /** @type {string} */ value) => {
            gameValues[id] = value;
        },
        resetCache(){},
    };
    /** @type {any} */
    let instance = null;
    const context = vm.createContext({
        ...policy,
        ...decisions,
        game,
        console,
        kute: { settings: { data: client }, running: pipeline, launchArgs: "", hostFeatures: [] },
        PIPELINE: [{ setting: "hardFlip", label: "DXGI Swapchain Hook" }],
        REPLAY_CIRCLE_MS: 600,
        performance: { now: () => clock },
        // timers run at once: the clock moves, nothing waits
        setTimeout: (/** @type {() => void} */ callback, /** @type {number} */ ms) => {
            clock += ms;
            callback();
            return 0;
        },
        clearTimeout(){},
        requestAnimationFrame: (/** @type {(now: number) => void} */ callback) => {
            clock += 1000 / (client.gameFpsLimit || 1000);
            callback(clock);
        },
        document: { querySelector: () => null, exitPointerLock(){} },
        window: { chrome: { webview: { postMessage(){} } } },
        localStorage: { getItem: () => null, setItem(){} },
        currentPipeline: () => ({ ...pipeline }),
        searchPipeline: async() => null,
        measureCaps: async() => null,
        hostLobby: async() => "test-room",
        spawn: async() => true,
        inRoom: () => true,
        request: async(/** @type {string} */ name) => {
            if (name === "get-specs") return { displays: [{ hz, hostsWindow: true }], laptop: mobile, onBattery: false, gpus: [] };
            if (name === "get-present-intervals" && presentMs) return { p50: presentMs(client.gameFpsLimit), samples: 100 };
            return null;
        },
        takeInputDiagnostics: () => ({ readings: 0, asked: 0, withInput: 0, pageEvents: 0, hostSteps: 0, ended: {}, invalid: {} }),
        takeReading: async(/** @type {{ms: number}} */ { ms }) => {
            clock += ms;
            const result = structuredClone(read({ phase, cap: client.gameFpsLimit, game: gameValues }));
            if (phase === cancelAt) instance.cancelled = true;
            return result;
        },
    });
    vm.runInContext(controller, context, { filename: "autoDetect/index.js" });
    instance = new context.AutoDetect();
    const baseline = { client: { ...structuredClone(client), ...(carry?.pipelineBefore ?? {}) }, game: structuredClone(gameValues) };
    const state = { snapshot: structuredClone(baseline), baseline: structuredClone(baseline), details: [], ...(carry ? { carry: structuredClone(carry) } : {}) };
    const panel = {
        progress(/** @type {string} */ text){
            phase = text;
        },
        clickThrough(){},
        choose(){},
    };
    const result = await instance.run(panel, state, { inMatch: false });
    return { result, client, game: gameValues };
}

/**
 * a laptop that collapses when it is pushed: without a limit and above 180 fps it stands still part of the time
 *
 * @param {{phase: string, cap: number}} state
 * @return {Fixture}
 */
const collapsesAbove180 = ({ cap }) => (cap === 0 || cap > 180 ? recorded(90, 10, 80) : reading(cap));

describe("a PC that collapses when it is pushed", () => {
    test("a limit of the player's own that runs steadily is kept, a lower one is only suggested", async() => {
        // was: 500 became 120 "for room" and the mouse wait went from 2.5 to 8.83 ms. the old auto-detect kept the 500
        const { result, client } = await run({
            cap: 500,
            read: (state) => (state.phase === "Measuring how the game runs now" ? reading(500) : collapsesAbove180(state)),
        });
        expect(client.gameFpsLimit).toBe(500);
        expect(result.summary.changed).toBe(false);
        expect(result.report.rolledBack).toBe(null);
        expect(result.report.pushed).toMatchObject({ steadyUpTo: 180, limit: 120 });
        expect(result.summary.line).toMatch(/Your limit of 500 FPS runs steadily in the test match, so Kute kept it\. If real matches still stutter, try 120 FPS/);
    });

    test("without a limit of their own the player gets the steady limit with room", async() => {
        // a real collapse: the mouse waits as long as the game stands still
        const { result, client } = await run({
            cap: 0,
            read: (state) => {
                const fixture = collapsesAbove180(state);
                return fixture.stallMs > 0 ? { ...fixture, inputP99: 30 } : fixture;
            },
        });
        expect(client.gameFpsLimit).toBe(120);
        expect(result.summary.title).toBe("Optimized");
        expect(result.report.rolledBack).toBe(null);
        expect(result.summary.line).toMatch(/Kute limits it to 120 FPS, which ran steadily with room to spare/);
        expect(result.report.after.stallMs.median).toBe(0);
    });

    test("room is not taken when it makes the mouse wait longer than the collapse did", async() => {
        // this collapse stalls but its mouse wait is 5.5 ms: 120 fps would wait 8.8 ms, the highest steady limit 6.1
        const { result, client } = await run({ cap: 0, read: collapsesAbove180 });
        expect(client.gameFpsLimit).toBe(180);
        expect(result.report.rolledBack).toBe(null);
        expect(result.summary.line).toMatch(/Kute limits it to 180 FPS, which ran steadily\./);
    });

    test("no limit runs steadily: nothing changes and nothing is called optimized", async() => {
        // was: the refresh rate became the limit unproven, fps went from 80 to 60 with more stalls, reported as "Optimized"
        let last = 0;
        const { result, client } = await run({
            cap: 0,
            hz: 360,
            read: ({ phase, cap }) => {
                if (phase === "Measuring how the game runs now" || cap === 0) return recorded(90, 10, 80);
                if (phase === "Checking the result") return (++last % 2) ? recorded(95, 5, 100) : recorded(90, 10, 500);
                return recorded(90, 10, 500);
            },
        });
        expect(client.gameFpsLimit).toBe(0);
        expect(result.summary.changed).toBe(false);
        expect(result.summary.title).toBe("No steady setting found");
        expect(result.report.pushed).toMatchObject({ steadyUpTo: null, limit: null });
        expect(result.summary.line).not.toMatch(/steadily with room|runs steadily in the test match/);
    });

    test("a result that cannot be measured puts the player's limit back", async() => {
        const { result, client } = await run({
            cap: 0,
            read: (state) => (state.phase === "Checking the result" ? reading(120, { invalid: true }) : collapsesAbove180(state)),
        });
        expect(result.report.rolledBack).toMatch(/could not measure the result/);
        expect(client.gameFpsLimit).toBe(0);
    });
});

describe("the last check", () => {
    test("unusable later readings of the player's limit do not replace the good ones from the start", async() => {
        // was: both remeasurements of the 200 limit lost focus, every comparison came back unknown and a game setting
        // that took the task delay from 2 to 8 ms was kept
        const { result, client, game } = await run({
            cap: 200,
            hz: 240,
            quality: true,
            read: ({ phase, cap, game: values }) => {
                const unlimited = values.postProcessing === "false" ? 600 : 500;
                const fps = cap > 0 ? Math.min(cap, 500) : unlimited;
                if (phase === "Finding the FPS limit that runs best" && cap === 200) return reading(fps, { invalid: true, why: "the window lost focus" });
                return reading(fps, { taskP99: values.postProcessing === "false" ? 8 : 2 });
            },
        });
        expect(result.report.rolledBack).toMatch(/the game reacted later/);
        expect(result.summary.changed).toBe(false);
        expect(game.postProcessing).toBe("true");
        expect(client.gameFpsLimit).toBe(200);
    });

    test("a healthy desktop keeps everything", async() => {
        const { result, client } = await run({ cap: 0, mobile: false, read: ({ cap }) => reading(cap || 1000) });
        expect(client.gameFpsLimit).toBe(0);
        expect(result.summary.changed).toBe(false);
        expect(result.summary.title).toBe("Nothing to change");
    });

    test("frames that never reach the screen get the target rate, like the old auto-detect gave", async() => {
        // 1000 drawn, 200 shown: the hook's presents come every 5 ms whatever the game draws above that
        const { result, client } = await run({
            cap: 0,
            mobile: false,
            read: ({ cap }) => reading(cap || 1000),
            presentMs: (cap) => Math.max(5, 1000 / (cap || 1000)),
        });
        expect(client.gameFpsLimit).toBe(180);
        expect(result.report.rolledBack).toBe(null);
    });
});

describe("after the restart for a new client setup", () => {
    const carry = {
        asPlayed: [reading(500), reading(500)],
        uncapped: [reading(500), reading(500)],
        playedCap: 0,
        pipelineBefore: { hardFlip: false },
        pipelineAfter: { hardFlip: true },
        pipelineChanged: true,
        decidedBy: "fps",
        rows: [],
        benchCaps: [],
        capOrder: [],
        elapsedMs: 0,
    };

    test("a setup that is slower in the game goes back", async() => {
        const { result, client } = await run({ cap: 0, carry, read: () => reading(100) });
        expect(result.report.rolledBack).toMatch(/The setup that won the client test measured worse than yours/);
        expect(client.hardFlip).toBe(false);
        expect(result.summary.needsRestart).toBe(true);
    });

    test("a setup that cannot be measured goes back", async() => {
        const { result, client } = await run({ cap: 0, carry, read: () => reading(100, { invalid: true }) });
        expect(result.report.rolledBack).toMatch(/could not measure the result/);
        expect(client.hardFlip).toBe(false);
    });

    test("a player whose own setup collapses: the new setup is judged with the limit that steadies it", async() => {
        // comparing two collapses says nothing, the check right after the restart used to put the setup back for it
        const collapsed = { ...recorded(90, 10, 80), inputP99: 30 };
        const { result, client } = await run({
            cap: 0,
            carry: { ...carry, asPlayed: [collapsed, collapsed], uncapped: [collapsed, collapsed, collapsed] },
            read: (state) => {
                const fixture = collapsesAbove180(state);
                return fixture.stallMs > 0 ? { ...fixture, inputP99: 30 } : fixture;
            },
        });
        expect(result.report.rolledBack).toBe(null);
        expect(client.hardFlip).toBe(true);
        expect(client.gameFpsLimit).toBe(120);
        expect(result.summary.title).toBe("Optimized");
    });

    test("a setup that runs as well is kept", async() => {
        const { result, client } = await run({ cap: 0, mobile: false, carry, read: ({ cap }) => reading(cap || 500) });
        expect(result.report.rolledBack).toBe(null);
        expect(client.hardFlip).toBe(true);
        expect(result.summary.changed).toBe(true);
    });
});

test("escape during the first readings ends the run without a result", async() => {
    const { result } = await run({ cancelAt: "Measuring how the game runs now", read: () => reading(500) });
    expect(result).toBe(null);
});
