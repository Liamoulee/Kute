import { FrameRecorder } from "./metrics.js";
import { decide } from "./decide.js";
import * as game from "./gameSettings.js";

// Standalone lab probe: `bun run lab` bundles this file to target/autodetect-lab.js. Paste that into the
// DevTools console of any Chromium on krunker.io (no Kute needed, so it also runs on Linux). It measures
// what the auto-detect rules are built on, restores every setting and downloads one JSON report.
// Start the browser with `--disable-frame-rate-limit --disable-gpu-vsync`, otherwise every sample is the refresh rate.
//
// Options, set before pasting: `window.kuteLab = { delay: 10, hz: 60 }`. With a delay the run starts that
// many seconds later, which leaves time to click into a match (run it once in the menu and once in a match).

const SAMPLE_MS = 1500;
const SETTLE_MS = 500;

/** @type {{delay?: number, hz?: number}} */
const options = /** @type {any} */ (window).kuteLab ?? {};

/**
 * @param {number} ms
 * @return {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

/**
 * @return {Promise<import("./metrics.js").FrameStats|null>}
 */
function measure(){
    return new Promise((resolve) => {
        const recorder = new FrameRecorder();
        const start = performance.now();
        const frame = () => {
            const now = performance.now();
            recorder.frame(now);
            if (now - start < SAMPLE_MS) requestAnimationFrame(frame);
            else resolve(recorder.stats(8));
        };
        requestAnimationFrame(frame);
    });
}

/**
 * @return {string}
 */
function gpuName(){
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
}

/**
 * @param {string} text
 */
function status(text){
    let box = document.querySelector("#kuteLabStatus");
    if (!box){
        box = document.createElement("div");
        box.id = "kuteLabStatus";
        /** @type {HTMLElement} */ (box).style.cssText =
            "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:6px 14px;border-radius:6px;" +
            "background:#000c;color:#35e0e8;font:14px Consolas,monospace;pointer-events:none";
        document.body.append(box);
    }
    box.textContent = text;
    console.log(`[kute lab] ${text}`);
}

/** @type {number|null} The closing baseline of the last probe, which is the opening one of the next */
let carriedBaseline = null;

/**
 * Measures one value of one setting between two baseline samples and puts the old value back.
 *
 * @param {string} id
 * @param {string} value
 * @param {string} before
 * @return {Promise<{id: string, value: string, before: string, fps: number, baseline: number, gain: number}>}
 */
async function probe(id, value, before){
    const first = carriedBaseline ?? (await measure())?.fps ?? 0;
    game.write(id, value);
    await sleep(SETTLE_MS);
    const fps = (await measure())?.fps ?? 0;
    game.write(id, before);
    await sleep(SETTLE_MS);
    const second = (await measure())?.fps ?? 0;
    carriedBaseline = second;
    // a hiccup only ever makes a sample slower, so the better baseline is the honest one
    const baseline = Math.max(first, second);
    return { id, value, before, fps, baseline, gain: baseline > 0 ? fps / baseline : 0 };
}

/**
 * The whole lab run.
 */
async function run(){
    if (typeof window.setSetting !== "function" || !Array.isArray(window.windows)){
        status("this is not a loaded krunker.io page");
        return;
    }
    for (let left = options.delay ?? 0; left > 0; left--){
        status(`starting in ${left} s, click into the match now`);
        await sleep(1000);
    }

    const snapshot = Object.fromEntries(game.ALL_IDS.map((id) => [id, game.read(id)]));
    const resolution = Number(snapshot[game.RESOLUTION]) || 1;
    const inMatch = Boolean(document.pointerLockElement);

    /** @type {Record<string, any>} */
    const report = {
        version: 1,
        at: new Date().toISOString(),
        userAgent: navigator.userAgent,
        gpu: gpuName(),
        threads: navigator.hardwareConcurrency,
        window: [window.innerWidth, window.innerHeight, devicePixelRatio],
        screen: [screen.width, screen.height],
        hz: options.hz ?? 60,
        inMatch,
        activity: (() => {
            try {
                return window.getGameActivity();
            }
            catch {
                return null;
            }
        })(),
        snapshot,
        resolution: [],
        settings: [],
    };

    try {
        if (Number(snapshot[game.GAME_FRAME_CAP]) > 0) game.write(game.GAME_FRAME_CAP, "0");

        status("baseline");
        await sleep(SETTLE_MS);
        report.base = await measure();

        // the resolution curve: tells the regime and checks the pixel count law the resolution step relies on
        for (const factor of [0.5, 0.75, 1.5, 2]){
            const scale = Math.round(resolution * factor * 100) / 100;
            if (scale < 0.1 || scale > 2) continue;
            status(`resolution ${scale}`);
            report.resolution.push(await probe(game.RESOLUTION, String(scale), String(resolution)));
        }

        // every setting that applies live, one at a time, in both directions: what it costs when it is on,
        // what it saves when it is off. the reload-only ones cannot be measured inside one page
        for (const tier of game.TIERS){
            for (const setting of tier.settings){
                if (setting.needsReload) continue;
                const before = snapshot[setting.id];
                if (before === null) continue;
                const cheap = String(setting.cheap);
                let other = cheap;
                if (before === cheap) other = cheap === "true" ? "false" : "true";
                status(`${setting.label}: ${before} -> ${other}`);
                report.settings.push({ tier: tier.name, ...(await probe(setting.id, other, before)) });
            }
        }

        status("baseline again");
        report.baseEnd = await measure();

        const low = report.resolution.find((/** @type {{value: string}} */ entry) => Number(entry.value) === Math.round(resolution * 50) / 100);
        const high = report.resolution.find((/** @type {{value: string}} */ entry) => Number(entry.value) === resolution * 2);
        report.decision = decide(
            {
                baseFps: report.base?.fps ?? 0,
                lowResFps: low?.fps ?? 0,
                highResFps: high?.fps ?? null,
                p50: report.base?.p50 ?? 0,
                p99: report.base?.p99 ?? 0,
                presentFps: 0,
            },
            {
                hz: report.hz,
                onBattery: false,
                readGameSetting: (id) => snapshot[id],
                throttle: 1,
                gameFpsLimit: 0,
                gameFrameCap: Number(snapshot[game.GAME_FRAME_CAP]) || 0,
            },
        );
    }
    finally {
        for (const [id, value] of Object.entries(snapshot)){
            if (value !== null && game.read(id) !== value) game.write(id, value);
        }
    }

    const json = JSON.stringify(report, null, 2);
    localStorage.setItem("kute_lab_report", json);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    link.download = `kute-lab-${inMatch ? "match" : "menu"}-${Date.now()}.json`;
    link.click();
    console.log(json);
    status(`done, ${Math.round(report.base?.fps ?? 0)} FPS baseline. report downloaded (also in localStorage.kute_lab_report)`);
}

run();
