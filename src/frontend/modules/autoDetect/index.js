import panelHtml from "../../components/autoDetect.html";
import { kute } from "../../client.js";
import { activity, hostLobby, spawn } from "../privateMatch.js";
import { checkCompMode, request } from "../../utils.js";
import { FrameRecorder } from "./metrics.js";
import { decide, decideClient, HEADROOM, MIN_RESOLUTION, SIGNIFICANT_SETTING, TARGET_REFRESH_MULTIPLE } from "./decide.js";
import * as game from "./gameSettings.js";
import api from "../api.js";

const STORAGE_KEY = "kute_autodetect";
// how many runs finished on this install. shared with a report so that first runs can be told from repeats,
// which a server without any kind of client id could not do otherwise
const RUNS_KEY = "kute_autodetect_runs";
// "this client start already asked". sessionStorage, not localStorage: the bundle runs again on every F5, F4 and
// lobby change, and "ask me later" means the next start, not the next page. the profile deletes its Sessions
// folder on start (app.rs), so this dies with the client, which is exactly that meaning
const ASKED_KEY = "kute_autodetect_asked";
// this module is imported when the game reports itself loaded, which is about 3.4 s into a page load and well
// after the menu is up, so the offer has nothing left to wait for. It used to wait five seconds on top of that,
// which put the first thing a new player ever sees eight and a half seconds into their first start
const OFFER_DELAY_MS = 250;
// a run is a different matter: it clicks its way through the menu to host a private match, so it lets the page
// settle first
const RESUME_RUN_DELAY_MS = 1500;
// how long the setup waits for a login before it gives up and asks again another day
const LOGIN_TIMEOUT_MS = 300000;
// and how long it waits for Krunker to sign an account that is already on this PC back in, see `signedIn`
const SIGN_IN_WAIT_MS = 20000;
const SAMPLE_MS = 900;
const SETTLE_MS = 450;
// samples of the same settings right before and after a measurement may differ by this share. beyond it
// something else moved (a hitch, a shader compile) and the number is not used
const STEADY_SPREAD = 0.08;
const CLIENT_KEYS = ["gameFpsLimit", "throttle", "hardFlip"];
/** how many present intervals the hook keeps (INTERVAL_SAMPLES in render-dll). a count that high means it overflowed */
const PRESENT_RING = 16384;
// the client configurations every run measures, the least restrictive first. "limit=auto" is a cap a bit
// below what the first one reaches, the classic advice against a graphics card that cannot keep up.
//
// No CPU throttle in here, on purpose. The throttle pauses the main thread for a share of the time, so it makes
// every long task longer by its factor (measured: the same task 91.9 ms at 1, 143.3 ms at 1.5). The bench scene
// has no long tasks, so there the throttle only acts like a crude limiter and wins (p99 1.0 ms against 3.3 ms
// on the owner's PC), and the run used to switch players with default settings onto it. In a real match that
// stretches every hitch, most of all the one when a player joins and Krunker builds their model. The FPS cap
// smooths the same way without that price
const CLIENT_CONFIGS = [
    { config: "hook=1", label: "Hook on, uncapped" },
    { config: "hook=0", label: "Hook off, uncapped" },
    { config: "hook=1,limit=auto", label: "Hook on, FPS cap" },
    { config: "hook=0,limit=auto", label: "Hook off, FPS cap" },
];
const HOME = "https://krunker.io/";

/**
 * @typedef {import("./decide.js").MeasuredSetting} MeasuredSetting
 */

/**
 * @typedef {object} Report Everything the run measured, shown in the Advanced view
 * @property {string} gpu
 * @property {string} cpu
 * @property {number} hz
 * @property {boolean} laptop
 * @property {number} baseFps
 * @property {number} p50
 * @property {number} p99
 * @property {number} presentFps
 * @property {number} noise Spread of three samples of the same settings
 * @property {number} drift Last baseline divided by the first one, below 1 when the PC got slower (heat)
 * @property {number|null} halfResolutionGain
 * @property {MeasuredSetting[]} settings
 * @property {import("./decide.js").ClientResult[]} client
 * @property {string} clientNote
 * @property {import("./decide.js").Plan} plan
 * @property {number|null} finalFps Measured again after the changes
 * @property {number} seconds
 * @property {Record<string, any>} [details] Only for the shared report: the system, the settings the run happened
 * under and the raw numbers behind the results, so that the rules can be re-evaluated later without new runs
 */

/**
 * @typedef {object} Summary
 * @property {string} title
 * @property {string} line
 * @property {string[]} details
 * @property {boolean} changed
 * @property {boolean} [needsRestart] A changed client setting only applies on the next start
 */

/**
 * @typedef {object} RunState
 * @property {"running"|"done"|"prompted"} status
 * @property {number} at
 * @property {{client: Record<string, any>, game: Record<string, string|null>}} snapshot What Undo and a cancel put
 *     back: the values from before the run, and before the setup's preset when the setup started it
 * @property {{client: Record<string, any>, game: Record<string, string|null>}} [baseline] While running: what is
 *     active when the run starts, after the preset and its reload. Everything the run measures and reverts to
 * @property {Summary} [summary]
 * @property {Report} [report]
 * @property {boolean} [showSummary] Set across the page load that ends a run
 * @property {boolean} [undoable] The snapshot holds values that differ from what is set now
 * @property {RunState|null} [previous] While running: the state to fall back to, it may still hold an undo
 * @property {WizardStage} [wizard] Where the first start setup stands
 * @property {string[]} [wizardDetails] What the setup already changed, shown in the summary of the run it starts
 */

/**
 * The steps of the first start setup. "later" and "declined" are answers, the rest are steps a page load can
 * land in the middle of (a login reloads the page, and so does the preset, most of which only applies then).
 *
 * @typedef {"later"|"declined"|"login"|"settings"|"import"|"run"} WizardStage
 */

/**
 * @param {number} ms
 * @return {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

/**
 * @return {RunState|null}
 */
function readState(){
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    }
    catch {
        return null;
    }
}

/**
 * @param {RunState} state
 */
function writeState(state){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/**
 * Hosting a test match needs an account.
 *
 * @return {boolean}
 */
export function loggedIn(){
    return document.querySelector("#signedInHeaderBar") !== null;
}

/**
 * Frame statistics of the page as it is, over one sample window.
 *
 * @param {number} [ms]
 * @return {Promise<import("./metrics.js").FrameStats>}
 */
function measure(ms = SAMPLE_MS){
    return new Promise((resolve) => {
        const recorder = new FrameRecorder();
        const start = performance.now();
        const frame = () => {
            const now = performance.now();
            recorder.frame(now);
            if (now - start < ms){
                requestAnimationFrame(frame);
                return;
            }
            resolve(recorder.stats(8) ?? { frames: 0, seconds: 0, fps: 0, meanMs: 0, p50: 0, p95: 0, p99: 0, p999: 0, maxMs: 0, hitches: 0, hitchesPerSec: 0 });
        };
        requestAnimationFrame(frame);
    });
}

/**
 * Sets a Kute setting without needing the settings page to be open.
 *
 * @param {string} id
 * @param {string|number|boolean} value
 */
function applyClient(id, value){
    kute.settings.data[id] = value;
    window.chrome.webview.postMessage(`set-config, ${id}, ${value}`);
    for (const selector of [`#${id}`, `#slid_input_${id}`]){
        const input = /** @type {HTMLInputElement|null} */ (document.querySelector(selector));
        if (input) input.value = String(value);
    }
}

/**
 * @param {string|number|boolean|null|undefined} value
 * @return {string} A stored value the way a player reads it
 */
function readable(value){
    if (value === null || value === undefined) return "default";
    if (String(value) === "true") return "on";
    if (String(value) === "false") return "off";
    return String(value);
}

/**
 * Test overrides from the launch arguments, e.g. `--autodetect-dev=hz:600,battery`. A strong PC clears
 * every goal, a pretend display is what makes it take the path of a weak one.
 *
 * @return {{hz?: number, battery?: boolean}}
 */
function devOverrides(){
    const match = /--autodetect-dev=(\S+)/.exec(kute.launchArgs ?? "");
    /** @type {{hz?: number, battery?: boolean}} */
    const overrides = {};
    for (const part of match?.[1].split(",") ?? []){
        const [key, value] = part.split(":");
        if (key === "hz") overrides.hz = Number(value);
        if (key === "battery") overrides.battery = true;
    }
    return overrides;
}

/**
 * Runs client configurations in bench processes (the host hides the game page meanwhile).
 *
 * @param {{config: string, label: string}[]} configs
 * @return {Promise<import("./decide.js").ClientResult[]>}
 */
async function measureClient(configs){
    /** @type {any[]|null} */
    const raw = await request(`run-bench-matrix ${JSON.stringify(configs.map((entry) => entry.config))}`, "benchMatrix", 20000 * configs.length);
    return configs.map((entry, index) => {
        const result = raw?.[index];
        const stats = result?.page?.stats;
        const present = result?.present;
        return {
            config: entry.config,
            label: entry.label,
            hook: !entry.config.includes("hook=0"),
            capped: entry.config.includes("limit="),
            throttled: entry.config.includes("throttle="),
            fps: stats?.fps ?? 0,
            p99: stats?.p99 ?? 0,
            low: stats?.p99 > 0 ? 1000 / stats.p99 : 0,
            p50: stats?.p50 ?? 0,
            max: stats?.maxMs ?? 0,
            present: typeof present?.p99 === "number" ? { p50: present.p50, p99: present.p99, max: present.max } : null,
            taskDelayP99: result?.page?.otherTasks?.p99 ?? 0,
            limit: result?.config?.limit ?? 0,
        };
    });
}

/**
 * The same configuration again, with "limit=auto" replaced by the cap that run really used.
 *
 * The host resolves "auto" to nine tenths of the FIRST result of the matrix it is given. In a second matrix that
 * holds only the two configurations being confirmed, a capped one in first place has no uncapped result to read,
 * so "auto" would fall back to the minimum of 30 and the confirmation would bench a 30 FPS cap against an
 * uncapped client. Every player who already has an FPS limit set walks into that.
 *
 * @param {import("./decide.js").ClientResult} row
 * @return {{config: string, label: string}}
 */
function replayConfig(row){
    const limit = Number(row.limit) || 0;
    return { config: limit > 0 ? row.config.replace("limit=auto", `limit=${limit}`) : row.config, label: row.label };
}

/**
 * The GPU the page really renders on. On a laptop with two that is not always the fast one.
 *
 * @return {string}
 */
function webglRenderer(){
    try {
        const gl = document.createElement("canvas").getContext("webgl2");
        const info = gl?.getExtension("WEBGL_debug_renderer_info");
        return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    }
    catch {
        return "";
    }
}

/**
 * @return {number[]} Width and height of the game's canvas, the pixels that really get rendered
 */
function gameCanvasSize(){
    let best = [0, 0];
    for (const canvas of document.querySelectorAll("canvas")){
        if (canvas.width * canvas.height > best[0] * best[1]) best = [canvas.width, canvas.height];
    }
    return best;
}

/**
 * @param {number} ratio
 * @return {string} "+12 %" style
 */
function percent(ratio){
    const value = Math.round((ratio - 1) * 100);
    return `${value > 0 ? "+" : ""}${value} %`;
}

/**
 * The Advanced view: what was measured, in the player's terms.
 *
 * @param {Report} report
 * @return {string}
 */
function advancedHtml(report){
    const changed = new Set(report.plan.changes.map((change) => change.id));
    const rows = report.settings.map((setting) => {
        let measured = setting.note ?? "";
        if (setting.gain !== null) measured = setting.steady ? `${percent(setting.gain)} when ${readable(setting.cheap)}` : "unsteady, not used";
        const action = changed.has(setting.id) ? `<td class="adChanged">set to ${readable(setting.cheap)}</td>` : "<td>kept</td>";
        return `<tr><td>${setting.label}</td><td>${readable(setting.current)}</td><td>${measured}</td>${action}</tr>`;
    });
    const limited = { cpu: "the processor", gpu: "the graphics card", unknown: "unknown" }[report.plan.regime];
    const half = report.halfResolutionGain === null ? "not measured" : percent(report.halfResolutionGain);
    return `
        <p>${report.gpu}<br>${report.cpu}${report.laptop ? " (laptop)" : ""}, ${report.hz} Hz</p>
        <p>${Math.round(report.baseFps)} FPS in the test match (median ${report.p50.toFixed(1)} ms, 1 % worst ${report.p99.toFixed(1)} ms),
        ${report.presentFps > 0 ? `${report.presentFps} reaching the screen, ` : ""}needed ${Math.round(report.plan.needed)}
        (goal ${report.plan.goal} plus headroom for fights and heat).</p>
        <p>Limited by ${limited} (half the resolution: ${half}). Same settings sampled three times differ by
        ${Math.round(report.noise * 100)} %, the PC ended the run at ${Math.round(report.drift * 100)} % of its starting speed.
        ${report.plan.healthy ? "" : "Frames were piling up behind the screen."}</p>
        ${report.finalFps === null ? "" : `<p>After the changes: ${Math.round(report.finalFps)} FPS.</p>`}
        <table><tr><th>Setting</th><th>Was</th><th>Measured</th><th>Result</th></tr>${rows.join("")}</table>
        <table><tr><th>Client</th><th>Average FPS</th><th>Slowest 1 % of frames</th></tr>${(report.client ?? [])
        .map((row) => `<tr><td>${row.label}</td><td>${row.fps > 0 ? Math.round(row.fps) : "failed"}</td><td>${row.fps > 0 ? `${(row.p99 ?? 0).toFixed(1)} ms` : ""}</td></tr>`)
        .join("")}</table>
        <p>${report.clientNote ?? ""}</p>
        <div class="adButton" id="adCopy" style="margin: 1em 0">Copy this report</div>
        <p>${report.seconds.toFixed(0)} s. Settings that need a reload or only cost something in a fight cannot be measured in an empty
        test match. They were not tested and not changed.</p>`;
}

class Panel {
    constructor(){
        document.querySelector("#adPanelHost")?.parentElement?.remove();
        this.overlay = document.createElement("div");
        // nearly opaque: the measurements change how the game looks behind it
        this.overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.93)";
        const host = document.createElement("div");
        host.id = "adPanelHost";
        this.overlay.append(host);
        this.root = host.attachShadow({ mode: "open" });
        this.root.innerHTML = panelHtml;
        document.body.append(this.overlay);
    }

    /**
     * @param {string} id
     * @return {HTMLElement}
     */
    element(id){
        return /** @type {HTMLElement} */ (this.root.querySelector(`#${id}`));
    }

    /**
     * @param {string} text
     * @param {number} fraction
     */
    progress(text, fraction){
        this.element("adStatus").textContent = text;
        this.element("adBarFill").style.width = `${Math.round(fraction * 100)}%`;
    }

    /**
     * A question with its own buttons, for the first start setup. Each choice decides itself whether it closes
     * the panel, a step that leads to the next one keeps it up.
     *
     * @param {string} title
     * @param {string} line
     * @param {{label: string, onPick: () => void}[]} choices
     */
    choose(title, line, choices){
        this.element("adTitle").textContent = title;
        this.element("adStatus").textContent = line;
        this.element("adBar").style.display = "none";
        this.element("adHint").style.display = "none";
        const actions = this.element("adActions");
        actions.style.display = "flex";
        actions.innerHTML = "";
        for (const choice of choices){
            const button = document.createElement("div");
            button.className = "adButton";
            button.textContent = choice.label;
            button.onclick = () => choice.onPick();
            actions.append(button);
        }
    }

    /**
     * Switches from the progress view to a message with buttons.
     *
     * @param {Summary} summary
     * @param {{onUndo?: () => void, onRun?: () => void, report?: Report}} [actions]
     */
    result(summary, actions = {}){
        this.element("adTitle").textContent = summary.title;
        this.element("adStatus").textContent = summary.line;
        this.element("adBar").style.display = "none";
        this.element("adHint").style.display = "none";
        this.element("adActions").style.display = "flex";
        this.element("adDetailsButton").style.display = "none";
        this.element("adUndo").style.display = summary.changed && actions.onUndo ? "" : "none";
        this.element("adRun").style.display = actions.onRun ? "" : "none";
        this.element("adRestart").style.display = summary.needsRestart ? "" : "none";
        this.element("adRestart").onclick = () => window.chrome.webview.postMessage("restart");
        this.element("adAdvancedButton").style.display = actions.report ? "" : "none";

        const details = this.element("adDetails");
        details.innerHTML = summary.details.map((line) => `<li>${line}</li>`).join("");
        details.style.display = summary.details.length > 0 ? "block" : "none";

        if (actions.report){
            const advanced = this.element("adAdvanced");
            advanced.innerHTML = advancedHtml(actions.report);
            this.element("adAdvancedButton").onclick = () => {
                advanced.style.display = advanced.style.display === "block" ? "none" : "block";
            };
            // for bug reports and for whoever tunes the rules: the numbers as they were measured
            this.element("adCopy").onclick = () => {
                const text = JSON.stringify({ kute: kute.version, ...actions.report }, null, 2);
                navigator.clipboard.writeText(text).then(
                    () => {
                        this.element("adCopy").textContent = "Copied";
                    },
                    () => {
                        this.element("adCopy").textContent = "Copying failed";
                    },
                );
            };
        }
        this.element("adOk").onclick = () => this.close();
        this.element("adUndo").onclick = () => {
            this.close();
            actions.onUndo?.();
        };
        this.element("adRun").onclick = () => {
            this.close();
            actions.onRun?.();
        };
    }

    /**
     * Lets clicks through to the game underneath (the host's click that spawns the player).
     *
     * @param {boolean} enabled
     */
    clickThrough(enabled){
        this.overlay.style.pointerEvents = enabled ? "none" : "";
    }

    close(){
        this.overlay.remove();
    }
}

class AutoDetect {
    constructor(){
        this.running = false;
        this.cancelled = false;
    }

    /**
     * @return {RunState["snapshot"]}
     */
    snapshot(){
        return {
            client: Object.fromEntries(CLIENT_KEYS.map((key) => [key, kute.settings.data[key]])),
            game: Object.fromEntries(game.ALL_IDS.map((id) => [id, game.read(id)])),
        };
    }

    /**
     * Puts every snapshotted value back.
     *
     * @param {RunState["snapshot"]} snapshot
     */
    restore(snapshot){
        game.resetCache();
        for (const [id, value] of Object.entries(snapshot.game)){
            if (value !== null && game.read(id) !== value) game.write(id, value);
        }
        for (const [id, value] of Object.entries(snapshot.client)){
            if (value !== undefined && kute.settings.data[id] !== value) applyClient(id, value);
        }
    }

    /**
     * Undoes the last run.
     */
    undo(){
        const state = readState();
        if (!state?.undoable){
            kute.showNotification("Nothing to undo", false, 3);
            return;
        }
        this.restore(state.snapshot);
        state.undoable = false;
        state.summary = { title: "Undone", line: "Your previous settings are back.", details: [], changed: false };
        writeState(state);
        kute.showNotification("Auto-detect undone, your previous settings are back", false, 4);
    }

    /**
     * Forgets the undo of the last run. Called when the player imports Krunker settings: the snapshot from before
     * the run would put old values over what they just imported.
     */
    dropUndo(){
        const state = readState();
        if (!state?.undoable) return;
        state.undoable = false;
        writeState(state);
    }

    /**
     * Shows the result of the last run again.
     */
    showLast(){
        const state = readState();
        if (!state?.summary){
            kute.showNotification("Auto-detect has not run yet", false, 3);
            return;
        }
        new Panel().result(state.summary, { onUndo: state.undoable ? () => this.undo() : undefined, report: state.report });
    }

    /**
     * @param {{snapshot?: RunState["snapshot"], details?: string[]}} [options] What the setup before this run
     * already changed, and the values from before it: Undo has to put those back too, and the summary lists them
     * @return {Promise<void>}
     */
    async start(options = {}){
        if (this.running) return;
        if (!loggedIn()){
            kute.showNotification("Log in first: auto-detect measures in a private test match, and hosting one needs an account", false, 6);
            return;
        }
        if (document.pointerLockElement || checkCompMode()){
            kute.showNotification("Open the menu outside of a competitive match first", false, 4);
            return;
        }
        this.running = true;
        this.cancelled = false;
        window.closWind?.();

        const previous = readState();
        // the setup is over the moment a run starts. without this a cancelled run would put its last step back
        // and the next page load would start the very same run again
        if (previous){
            delete previous.wizard;
            delete previous.wizardDetails;
        }
        // two different things once the setup's preset ran: Undo goes back to before the preset, the measurements
        // start from what the preset left. Mixing them had the run "revert" a setting to its pre-preset value and so
        // switch post-processing back on in the middle of measuring
        const baseline = this.snapshot();
        /** @type {RunState} */
        const state = { status: "running", at: Date.now(), snapshot: options.snapshot ?? baseline, baseline, previous };
        writeState(state);

        const panel = new Panel();
        /**
         * @param {KeyboardEvent} event
         */
        const onKey = (event) => {
            if (event.key === "Escape") this.cancelled = true;
        };
        document.addEventListener("keydown", onKey, true);

        // whoever cleans up has to know whether the page is still the menu, and a failure report how far it got
        const venue = { inMatch: false, stage: "start" };
        const startedAt = performance.now();
        /**
         * Back to how it was before the run.
         */
        const abandon = () => {
            this.restore(state.snapshot);
            if (previous) writeState(previous);
            else writeState({ status: "prompted", at: Date.now(), snapshot: state.snapshot });
            panel.close();
            if (venue.inMatch){
                document.exitPointerLock();
                location.href = HOME;
            }
        };

        try {
            const outcome = await this.run(panel, state, venue, options.details ?? []);
            if (outcome === null){
                abandon();
                return;
            }
            state.status = "done";
            state.summary = outcome.summary;
            state.report = outcome.report;
            state.undoable = outcome.summary.changed;
            // a run that changed nothing must not cost the player the undo of the run before it
            if (!outcome.summary.changed && previous?.undoable){
                state.snapshot = previous.snapshot;
                state.undoable = true;
            }
            delete state.previous;
            delete state.baseline;
            // the raw numbers are for the shared report, the stored one only needs what the Advanced view shows
            state.report = { ...outcome.report };
            delete state.report.details;
            // leaving the test match is a page load, the summary comes up after it
            state.showSummary = true;
            writeState(state);
            // shared unless the player switched it off: the measurements, no account, no ids (the host checks the setting too)
            const run = (Number(localStorage.getItem(RUNS_KEY)) || 0) + 1;
            localStorage.setItem(RUNS_KEY, String(run));
            if (kute.settings.data.telemetry !== false && await api.available()){
                window.chrome.webview.postMessage(`telemetry autodetect ${JSON.stringify({ kute: kute.version, run, ...outcome.report })}`);
            }
            panel.progress("Leaving the test match", 1);
            document.exitPointerLock();
            await sleep(800);
            location.href = HOME;
        }
        catch (error){
            abandon();
            const message = error instanceof Error ? error.message : String(error);
            kute.showNotification(`Auto-detect stopped: ${message}`, false, 7);
            // a run that breaks is the one we need to hear about: it is how a changed host window gets noticed
            if (kute.settings.data.telemetry !== false && await api.available()){
                const failure = { kute: kute.version, stage: venue.stage, message: message.slice(0, 200), seconds: (performance.now() - startedAt) / 1000 };
                window.chrome.webview.postMessage(`telemetry autodetect-failure ${JSON.stringify(failure)}`);
            }
        }
        finally {
            document.removeEventListener("keydown", onKey, true);
            window.chrome.webview.postMessage("throttle, menu");
            this.running = false;
        }
    }

    /**
     * The measuring and deciding part.
     *
     * @param {Panel} panel
     * @param {RunState} state
     * @param {{inMatch: boolean, stage: string}} venue
     * @param {string[]} earlier What the setup changed before the run, listed in the same summary
     * @return {Promise<{summary: Summary, report: Report}|null>} null when cancelled
     */
    async run(panel, state, venue, earlier = []){
        const started = performance.now();
        const dev = devOverrides();
        const baseline = state.baseline ?? state.snapshot;

        panel.progress("Reading your hardware", 0.02);
        const specs = await request("get-specs", "specs");
        // the bundle can be newer than the exe (hot update), and an exe without these queries also cannot
        // switch its throttle off or click into the match
        if (specs === null) throw new Error("this needs a newer version of the client");
        /** @type {{hz: number, hostsWindow: boolean}[]} */
        const displays = specs.displays ?? [];
        const display = displays.find((entry) => entry.hostsWindow) ?? displays[0];
        const hz = dev.hz ?? (display?.hz > 1 ? display.hz : 60);
        /** @type {{name: string, software: boolean, vramMb: number}[]} */
        const gpus = (specs.gpus ?? []).filter((/** @type {{software: boolean}} */ gpu) => !gpu.software);
        const gpuName = [...gpus].sort((a, b) => b.vramMb - a.vramMb)[0]?.name ?? "unknown graphics card";

        // the client first, from the menu: the host hides this page and shows its own test window meanwhile
        venue.stage = "client";
        panel.progress("Testing the client", 0.03);
        const settingsNow = {
            hardFlip: kute.settings.data.hardFlip !== false,
            capped: Number(kute.settings.data.gameFpsLimit) > 0,
            throttled: Number(kute.settings.data.throttle) > 1,
        };
        let client = await measureClient(CLIENT_CONFIGS);
        let clientPlan = decideClient(client, settingsNow, hz);
        let clientNote = "The client configuration in use measured as good as any other, nothing to change there.";
        if (client.every((row) => row.fps === 0)){
            clientNote = "The client test did not run, the client settings were left alone.";
        }
        else if (clientPlan.change && clientPlan.best && clientPlan.current){
            // one measurement is not enough to change something: the two run against each other once more
            panel.progress("Confirming the client test", 0.04);
            const [currentAgain, bestAgain] = await measureClient([replayConfig(clientPlan.current), replayConfig(clientPlan.best)]);
            const confirmed = decideClient([currentAgain, bestAgain], settingsNow, hz);
            if (confirmed.change) clientNote = `"${clientPlan.best.label}" measured clearly better than "${clientPlan.current.label}", twice.`;
            else {
                clientNote = `"${clientPlan.best.label}" looked better at first, but not when measured again. Nothing changed there.`;
                clientPlan = { ...clientPlan, change: false };
            }
            // by label, not by config: the replay resolved "limit=auto" to the number that run used
            client = client.map((row) => (row.label === bestAgain.label && bestAgain.fps > 0 ? { ...row, p99: Math.max(row.p99, bestAgain.p99), low: Math.min(row.low, bestAgain.low) } : row));
        }
        if (this.cancelled) return null;

        const clientSeconds = (performance.now() - started) / 1000;
        venue.stage = "lobby";
        panel.progress("Opening a private test match", 0.05);
        panel.clickThrough(true);
        let joined = await hostLobby();
        if (joined){
            panel.progress("Joining the test match", 0.1);
            joined = await spawn();
        }
        panel.clickThrough(false);
        if (!joined){
            window.closWind?.();
            throw new Error("could not open a private test match (is a host slot free?)");
        }
        venue.inMatch = true;
        venue.stage = "measure";
        const lobbySeconds = (performance.now() - started) / 1000 - clientSeconds;
        if (this.cancelled) return null;

        // measure the game itself: no throttle, no limiter of ours, no frame cap of the game
        window.chrome.webview.postMessage("throttle, off");
        const fpsLimitBefore = Number(kute.settings.data.gameFpsLimit) || 0;
        const frameCapBefore = Number(baseline.game[game.GAME_FRAME_CAP]) || 0;
        if (fpsLimitBefore > 0) applyClient("gameFpsLimit", 0);
        if (frameCapBefore > 0) game.write(game.GAME_FRAME_CAP, "0");
        // the first seconds of a match still stream assets and compile shaders
        await sleep(2500);
        // again: taking the pointer lock makes the client post its in-game throttle, and that can land after the
        // "off" above. a run measured 532 instead of 1500 frames per second that way
        window.chrome.webview.postMessage("throttle, off");
        await sleep(300);

        // a window that is minimized or behind another one renders differently, or not at all
        window.chrome.webview.postMessage("bring-to-front");
        panel.progress("Measuring your current settings", 0.15);
        // (the first call only starts a fresh window in the hook, the second one reads the baseline's presents)
        await request("get-present-intervals", "presentIntervals");
        const presentsSince = performance.now();
        const first = await measure();
        const repeats = [first.fps, (await measure()).fps, (await measure()).fps];
        const presentIntervals = (await request("get-present-intervals", "presentIntervals")) || null;
        // the presents the hook counted in exactly this window, per second. not "get-present": that is a moving
        // average which one long pause drags down for a while and which stays frozen when the hook goes quiet
        // (it once said 3 while the game ran at 1383). no answer, or a full ring that stopped counting: unknown
        const presentSeconds = (performance.now() - presentsSince) / 1000;
        const presentCount = Number(presentIntervals?.samples) || 0;
        const presentFps = presentCount > 0 && presentCount < PRESENT_RING ? Math.round(presentCount / presentSeconds) : 0;
        // what the frame loop ran at while those presents were counted. the health check compares the two, and
        // the run's baseline (the median over all of it) is a different window: the game is still warming up here
        const windowFps = repeats.reduce((sum, fps) => sum + fps, 0) / repeats.length;
        const base = first;
        const noise = (Math.max(...repeats) - Math.min(...repeats)) / Math.max(1, Math.max(...repeats));
        // every sample of the unchanged settings, from the first second to the last. what the PC holds is their
        // median: the first seconds of a match run below it (the game is still warming up, 1340 against 1900
        // at the end of one run), a laptop's last ones run below it too (heat), and a single sample is luck
        const baselines = [...repeats];
        /**
         * @return {number}
         */
        const baselineFps = () => {
            const sorted = [...baselines].sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length / 2)];
        };
        if (this.cancelled) return null;

        // every measurement sits between two samples of the unchanged settings and is compared with their
        // mean. a laptop gets slower by a third while it warms up, and this is what takes that drift out
        let reference = repeats[2];
        /**
         * @param {() => void} apply
         * @param {() => void} revert
         * @return {Promise<{ratio: number, steady: boolean, raw: number[]}>}
         */
        const compare = async(apply, revert) => {
            const before = reference;
            apply();
            await sleep(SETTLE_MS);
            const changed = await measure();
            revert();
            await sleep(SETTLE_MS);
            const after = (await measure()).fps;
            reference = after;
            baselines.push(after);
            const mean = (before + after) / 2;
            return {
                ratio: changed.fps / Math.max(1, mean),
                steady: Math.abs(before - after) / Math.max(1, mean) <= STEADY_SPREAD,
                raw: [before, changed.fps, after],
            };
        };

        /** @type {MeasuredSetting[]} */
        const settings = [];
        const live = game.SETTINGS.filter((setting) => !setting.needsReload && !setting.fightOnly);
        for (const setting of game.SETTINGS){
            const current = baseline.game[setting.id];
            const cheap = String(setting.cheap);
            /** @type {MeasuredSetting} */
            const row = { id: setting.id, label: setting.label, current: current ?? "default", cheap, gain: null, steady: true };
            settings.push(row);
            if (setting.needsReload){
                row.note = "not tested (needs a reload)";
                continue;
            }
            // an empty match never shows what these cost, and the run does not shoot to find out
            if (setting.fightOnly){
                row.note = "not tested (only costs in a fight)";
                continue;
            }
            if (current === null){
                row.note = "value unknown";
                continue;
            }
            if (this.cancelled) return null;

            panel.progress(`Measuring ${setting.label}`, 0.2 + (0.6 * live.indexOf(setting)) / live.length);
            const flipped = game.opposite(current);
            const { ratio, steady, raw } = await compare(() => game.write(setting.id, flipped), () => game.write(setting.id, current));
            // always stored as "what the cheap value gains", whichever direction was measured
            row.gain = flipped === cheap ? ratio : 1 / Math.max(0.01, ratio);
            row.steady = steady;
            row.raw = raw;
        }
        if (this.cancelled) return null;

        // one measurement is enough for the diagnostics, not for changing something: a setting that is about
        // to be switched gets measured a second time, and the lower of the two numbers counts
        if (baselineFps() < hz * TARGET_REFRESH_MULTIPLE * HEADROOM){
            for (const row of settings){
                if (row.gain === null || !row.steady || row.current === row.cheap || row.gain < SIGNIFICANT_SETTING) continue;
                if (this.cancelled) return null;
                panel.progress(`Confirming ${row.label}`, 0.8);
                const { ratio, steady } = await compare(() => game.write(row.id, row.cheap), () => game.write(row.id, row.current));
                row.confirmGain = ratio;
                row.gain = Math.min(row.gain, ratio);
                row.steady = steady;
            }
        }

        panel.progress("Checking the graphics card", 0.82);
        const resolution = Number(baseline.game[game.RESOLUTION]) || 1;
        const half = await compare(
            () => game.write(game.RESOLUTION, String(Math.max(0.1, resolution * 0.5))),
            () => game.write(game.RESOLUTION, String(resolution)),
        );
        // the scale is linear, so half of it is a quarter of the pixels, and fewer pixels cannot be slower:
        // a ratio below 1 is a hiccup during the measurement, not a result
        const halfResolutionGain = half.steady && half.ratio > 0.92 ? half.ratio : null;
        const drift = reference / Math.max(1, repeats[0]);
        const baseFps = baselineFps();
        if (this.cancelled) return null;

        const plan = decide(
            { baseFps, p50: base.p50, p99: base.p99, presentFps, windowFps, halfResolutionGain, settings },
            {
                hz,
                onBattery: dev.battery ?? Boolean(specs.onBattery),
                throttle: Number(baseline.client.throttle) || 1,
                gameFpsLimit: fpsLimitBefore,
                gameFrameCap: frameCapBefore,
                hardFlip: settingsNow.hardFlip,
                client: clientPlan.change ? clientPlan.best : null,
            },
        );

        venue.stage = "apply";
        panel.progress("Applying", 0.88);
        /** @type {string[]} */
        const details = [...earlier];
        /**
         * The client changes wait until the measuring below is done. An FPS limit or a CPU throttle applied here
         * would be what the final measurement reads, and the resolution loop compares that number with the goal
         * the PC has to reach UNCAPPED: with a cap of 720 and a goal of 900 no resolution can ever satisfy it, so
         * the scale walks down to its floor for nothing. What the client settings deliver is a separate question
         * from what this PC can do.
         *
         * @type {import("./decide.js").Change[]}
         */
        const clientChanges = [];
        let limitChanged = false;
        let gameChanged = false;
        let needsRestart = false;
        for (const change of plan.changes){
            if (change.scope === "game"){
                details.push(`<b>${change.label}</b>: ${readable(baseline.game[change.id])} → ${readable(change.value)} (${change.reason})`);
                game.write(change.id, String(change.value));
                if (change.id !== game.GAME_FRAME_CAP) gameChanged = true;
            }
            else {
                details.push(`<b>${change.label}</b>: ${readable(baseline.client[change.id])} → ${readable(change.value)} (${change.reason})`);
                clientChanges.push(change);
                if (change.id === "gameFpsLimit") limitChanged = true;
                if (change.id === "hardFlip") needsRestart = true;
            }
        }

        // what the gains added up to is a prediction, this is the check
        let finalFps = null;
        if (gameChanged || plan.tuneResolution){
            await sleep(SETTLE_MS);
            finalFps = (await measure()).fps;
        }

        // the resolution scale only goes down when fewer pixels measurably helped and the goal is still
        // missed. frame rate follows the pixel count then, so one estimate lands close and gets verified
        if (plan.tuneResolution && finalFps !== null){
            let scale = resolution;
            for (let step = 0; step < 2 && finalFps < plan.needed && scale > MIN_RESOLUTION && !this.cancelled; step++){
                const estimate = step === 0 ? scale * Math.sqrt(finalFps / plan.needed) : MIN_RESOLUTION;
                scale = Math.min(scale, Math.max(MIN_RESOLUTION, Math.floor(estimate * 20) / 20));
                panel.progress(`Trying resolution ${scale}`, 0.92 + step * 0.03);
                game.write(game.RESOLUTION, String(scale));
                await sleep(SETTLE_MS);
                finalFps = (await measure()).fps;
            }
            if (scale !== resolution) details.push(`<b>Resolution</b>: ${resolution} → ${scale} (the graphics card is the limit)`);
        }
        if (this.cancelled) return null;

        // measuring is over, the client settings can take effect now
        for (const change of clientChanges) applyClient(change.id, change.value);
        if (!limitChanged && fpsLimitBefore > 0) applyClient("gameFpsLimit", fpsLimitBefore);
        game.resetCache();

        const changed = details.length > 0;
        let line = `${Math.round(baseFps)} FPS in the test match, this PC holds its goal of ${plan.goal}. Nothing to change.`;
        if (changed){
            line =
                `${details.length} setting${details.length === 1 ? "" : "s"} changed. ` +
                `${Math.round(baseFps)} FPS before${finalFps === null ? "" : `, ${Math.round(finalFps)} after`}, goal ${plan.goal}.`;
        }
        else if (!plan.holds){
            line = `${Math.round(baseFps)} FPS in the test match, goal ${plan.goal}. No setting measurably helps on this PC, so nothing was changed.`;
        }

        return {
            summary: { title: changed ? "Optimized" : "Nothing to change", line: needsRestart ? `${line} Restart Kute to finish.` : line, details, changed, needsRestart },
            report: {
                gpu: gpuName,
                cpu: `${specs.cpu?.name ?? "unknown processor"}, ${specs.cpu?.threads ?? "?"} threads`,
                hz,
                laptop: Boolean(specs.laptop),
                baseFps,
                p50: base.p50,
                p99: base.p99,
                presentFps,
                noise,
                drift,
                halfResolutionGain,
                settings,
                client,
                clientNote,
                plan,
                finalFps,
                seconds: (performance.now() - started) / 1000,
                details: {
                    system: {
                        gpus: (specs.gpus ?? []).map((/** @type {Record<string, any>} */ gpu) => ({ name: gpu.name, vramMb: gpu.vramMb, software: gpu.software })),
                        renderer: webglRenderer(),
                        threads: specs.cpu?.threads ?? 0,
                        ramGb: Math.round((specs.ramMb ?? 0) / 1024),
                        osBuild: specs.osBuild ?? "",
                        displays: displays.map((/** @type {Record<string, any>} */ entry) => ({ width: entry.width, height: entry.height, hz: entry.hz, hostsWindow: Boolean(entry.hostsWindow) })),
                        window: [window.innerWidth, window.innerHeight],
                        canvas: gameCanvasSize(),
                        pixelRatio: devicePixelRatio,
                        onBattery: Boolean(specs.onBattery),
                        userFlags: specs.userFlags ?? [],
                        disabledDefaults: specs.disabledDefaults ?? [],
                    },
                    clientSettings: Object.fromEntries(
                        ["hardFlip", "uncapFps", "gameFpsLimit", "throttle", "inMenuThrottle", "webviewPriority", "angleBackend", "colorProfile", "rawInput"]
                            .map((key) => [key, key in baseline.client ? baseline.client[key] : kute.settings.data[key]]),
                    ),
                    game: {
                        resolution,
                        frameCap: frameCapBefore,
                        map: activity().map ?? "",
                    },
                    baseline: {
                        samples: baselines,
                        p50: base.p50,
                        p95: base.p95,
                        p99: base.p99,
                        p999: base.p999,
                        max: base.maxMs,
                        present: presentIntervals,
                    },
                    halfResolution: half.raw,
                    timings: { clientSeconds, lobbySeconds },
                },
            },
        };
    }

    /**
     * Remembers where the setup stands, keeping what is already stored: the setup can be started from the
     * settings long after a run, and the result of that run is what "Last Auto-Detect Result" shows.
     *
     * @param {WizardStage} wizard
     * @param {RunState["snapshot"]} [snapshot]
     * @param {string[]} [details] What the setup changed before the run it is about to start
     */
    remember(wizard, snapshot, details){
        const state = readState() ?? { status: /** @type {const} */ ("prompted"), at: Date.now(), snapshot: { client: {}, game: {} } };
        writeState({ ...state, at: Date.now(), wizard, ...(snapshot ? { snapshot } : {}), ...(details ? { wizardDetails: details } : {}) });
    }

    /**
     * Step 1: the offer on a first start. Asked once per client start at most.
     */
    offer(){
        if (this.running || sessionStorage.getItem(ASKED_KEY)) return;
        // a player who is already in the match gets asked once they are back in the menu. giving up here
        // meant that whoever clicked play within five seconds never saw this at all
        if (document.pointerLockElement){
            document.addEventListener("pointerlockchange", () => setTimeout(() => this.offer(), 1500), { once: true });
            return;
        }
        sessionStorage.setItem(ASKED_KEY, "1");
        const panel = new Panel();
        panel.choose(
            "Set Kute up for this PC?",
            "Kute can set the game up for what this PC can do: it measures in a private test match for about a minute, and everything it changes can be undone. You have to be logged in for that.",
            [
                {
                    label: "Yes",
                    onPick: () => {
                        this.setUp(panel);
                    },
                },
                {
                    label: "Ask later",
                    onPick: () => {
                        panel.close();
                        this.remember("later");
                    },
                },
                {
                    label: "No",
                    onPick: () => {
                        panel.close();
                        this.remember("declined");
                        kute.showNotification("Got it. You can always start the setup from Settings, Client", false, 5);
                    },
                },
            ],
        );
    }

    /**
     * Whether the player is signed in, giving Krunker the time it needs to do it.
     *
     * A page load shows the signed OUT header bar first and swaps it for the signed in one once the account is
     * back, which was measured taking well over five seconds. Asking right after a load therefore says "logged
     * out" for a player who is not, and the setup would send them to a login form they do not need. The token in
     * localStorage is what says an account lives on this PC, so that decides whether there is anything to wait for.
     *
     * @return {Promise<boolean>}
     */
    async signedIn(){
        if (loggedIn()) return true;
        if (!localStorage.getItem("krunker_token")) return false;
        const until = Date.now() + SIGN_IN_WAIT_MS;
        while (Date.now() < until){
            await sleep(250);
            if (loggedIn()) return true;
        }
        return false;
    }

    /**
     * The setup from here on, and what the button in the settings calls: the login step when it is needed, then
     * the question where the game settings come from. A player who is signed in is never asked to sign in.
     *
     * @param {Panel} [panel] The panel to carry on in, so the steps do not flicker
     * @return {Promise<void>}
     */
    async setUp(panel = new Panel()){
        if (this.running){
            panel.close();
            return;
        }
        panel.choose("Setting Kute up", "Checking your account.", []);
        if (!await this.signedIn()){
            this.askLogin(panel);
            return;
        }
        this.askSettings(panel);
    }

    /**
     * Step 2: the login.
     *
     * @param {Panel} [panel]
     */
    askLogin(panel = new Panel()){
        // a login reloads the page, so where the setup stands has to be on disk before the form opens
        this.remember("login");
        panel.choose("Log in to continue", "Kute measures in a private test match, and hosting one needs an account.", [
            {
                label: "Log in",
                onPick: () => {
                    panel.close();
                    window.loginOrRegister();
                    this.waitForLogin();
                },
            },
            {
                label: "Ask later",
                onPick: () => {
                    panel.close();
                    this.remember("later");
                },
            },
        ]);
    }

    /**
     * Carries on once the player is signed in. The page usually reloads on a login and `resume` picks the setup
     * back up, this is for the times it does not.
     */
    waitForLogin(){
        const until = Date.now() + LOGIN_TIMEOUT_MS;
        const timer = setInterval(() => {
            if (loggedIn()){
                clearInterval(timer);
                this.askSettings();
                return;
            }
            // one id lookup a second, and only in the menu. giving up leaves "login" behind, which asks again
            // on the next start
            if (Date.now() > until) clearInterval(timer);
        }, 1000);
    }

    /**
     * Step 3: where the game settings come from. Asked on a first start and on every run started from the
     * settings, because the answer can be different today than it was last time.
     *
     * @param {Panel} [panel]
     */
    askSettings(panel = new Panel()){
        this.remember("settings");
        panel.choose(
            "Where should your game settings come from?",
            "Kute measures this PC either way and sets what it finds. This is only about the settings it starts from.",
            [
                {
                    label: "Import a settings.txt",
                    onPick: () => {
                        panel.close();
                        this.remember("import");
                        window.importSettingsPopup();
                    },
                },
                {
                    label: "Kute's preset",
                    onPick: () => {
                        panel.close();
                        this.applyPreset();
                    },
                },
                {
                    label: "Keep my settings",
                    onPick: () => {
                        panel.close();
                        this.start();
                    },
                },
            ],
        );
    }

    /**
     * Called by `importSettings.js` once an import went through, which is the point the setup continues from.
     */
    afterImport(){
        if (readState()?.wizard !== "import") return;
        // the snapshot is taken now, after the import: what the player just imported is theirs, Undo must not
        // put the values from before it back. the same reason `importSettings.js` drops the undo of a run.
        // an import may reload the page, so the step goes on disk first and both ways end in the same run
        const snapshot = this.snapshot();
        // nothing for the summary: an import is the player's own doing, and the list is what Kute changed
        this.remember("run", snapshot, []);
        setTimeout(() => {
            if (readState()?.wizard === "run") this.start({ snapshot });
        }, 1500);
    }

    /**
     * Writes the preset and reloads. Most of it only applies after a reload, and measuring a half applied
     * state would produce numbers nobody can read afterwards.
     */
    applyPreset(){
        // before the first value is written: this is what Undo puts back
        const snapshot = this.snapshot();
        /** @type {string[]} */
        const details = [];
        for (const [id, value] of Object.entries(game.PRESET)){
            if (String(snapshot.game[id]) === String(value)) continue;
            game.write(id, value);
            details.push(`<b>${game.label(id)}</b>: ${readable(snapshot.game[id])} → ${readable(value)} (Kute's preset)`);
        }
        this.remember("run", snapshot, details);
        kute.showNotification("Applying Kute's preset, the game reloads once", false, 4);
        setTimeout(() => location.reload(), 1200);
    }

    /**
     * Start of the page: finish or clean up what a previous page left, or carry the setup on. A first start
     * (or cleared storage) asks before anything is measured or changed.
     */
    resume(){
        const state = readState();
        if (state?.status === "running"){
            // the client was closed or crashed in the middle of a run
            this.restore(state.snapshot);
            if (state.previous) writeState(state.previous);
            else localStorage.removeItem(STORAGE_KEY);
            return;
        }
        if (state?.showSummary && state.summary){
            state.showSummary = false;
            writeState(state);
            new Panel().result(state.summary, { onUndo: () => this.undo(), report: state.report });
            return;
        }
        // the page load after the preset was written, or after an import that reloaded. the account is not
        // back yet this early in a load, and the run refuses to start without one
        if (state?.wizard === "run"){
            setTimeout(async() => {
                if (await this.signedIn()) this.start({ snapshot: state.snapshot, details: state.wizardDetails ?? [] });
            }, RESUME_RUN_DELAY_MS);
            return;
        }
        // a page load in the middle of the setup. "import" lands here when the popup was closed without
        // importing, so it asks again instead of measuring something nobody asked for
        if (state?.wizard === "login" || state?.wizard === "settings" || state?.wizard === "import"){
            setTimeout(() => this.setUp(), OFFER_DELAY_MS);
            return;
        }
        if (state && state.wizard !== "later") return;
        setTimeout(() => this.offer(), OFFER_DELAY_MS);
    }
}

const autoDetect = new AutoDetect();
kute.autoDetect = autoDetect;
autoDetect.resume();
