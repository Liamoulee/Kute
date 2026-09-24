import panelHtml from "../../components/autoDetect.html";
import { kute } from "../../client.js";
import { hostLobby, inRoom, spawn } from "../privateMatch.js";
import { checkCompMode, request } from "../../utils.js";
import { FrameRecorder } from "./metrics.js";
import { decide, decideClient, HEADROOM, MIN_RESOLUTION, SIGNIFICANT_SETTING, TARGET_REFRESH_MULTIPLE } from "./decide.js";
import * as game from "./gameSettings.js";

const STORAGE_KEY = "kute_autodetect";
// session storage so "later" means next client start, not next page load
const ASKED_KEY = "kute_autodetect_asked";
// module loads ~3.4 s in, menu is already up
const OFFER_DELAY_MS = 250;
// a run clicks through the menu, let the page settle first
const RESUME_RUN_DELAY_MS = 1500;
const LOGIN_TIMEOUT_MS = 300000;
// wait for krunker to sign a known account back in, see signedIn
const SIGN_IN_WAIT_MS = 20000;
const SAMPLE_MS = 900;
const SETTLE_MS = 450;
// max spread between the samples around a measurement before we drop it
const STEADY_SPREAD = 0.08;
const CLIENT_KEYS = ["gameFpsLimit", "throttle", "hardFlip"];
/** hook's present ring size (INTERVAL_SAMPLES in render-dll), a count this high means overflow */
const PRESENT_RING = 16384;
// least restrictive first. no cpu throttle on purpose, it stretches every long task in a real match
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
 * @typedef {object} Report what the run measured, for the advanced view
 * @property {string} gpu
 * @property {string} cpu
 * @property {number} hz
 * @property {boolean} laptop
 * @property {number} baseFps
 * @property {number} p50
 * @property {number} p99
 * @property {number} presentFps
 * @property {number} noise spread of three samples of the same settings
 * @property {number} drift last baseline / first, below 1 when the PC got slower (heat)
 * @property {number|null} halfResolutionGain
 * @property {MeasuredSetting[]} settings
 * @property {import("./decide.js").ClientResult[]} client
 * @property {string} clientNote
 * @property {import("./decide.js").Plan} plan
 * @property {number|null} finalFps measured again after the changes
 * @property {number} seconds
 */

/**
 * @typedef {object} Summary
 * @property {string} title
 * @property {string} line
 * @property {string[]} details
 * @property {boolean} changed
 * @property {boolean} [needsRestart] a changed client setting only applies on next start
 */

/**
 * @typedef {object} RunState
 * @property {"running"|"done"|"prompted"} status
 * @property {number} at
 * @property {{client: Record<string, any>, game: Record<string, string|null>}} snapshot what undo and cancel restore
 *     (from before the preset when the setup started the run)
 * @property {{client: Record<string, any>, game: Record<string, string|null>}} [baseline] while running: what was
 *     active at run start, after the preset. the run measures against and reverts to this
 * @property {Summary} [summary]
 * @property {Report} [report]
 * @property {boolean} [showSummary] set across the page load that ends a run
 * @property {boolean} [undoable] snapshot differs from what's set now
 * @property {RunState|null} [previous] while running: state to fall back to, may still hold an undo
 * @property {WizardStage} [wizard] first start setup progress
 * @property {string[]} [wizardDetails] what the setup already changed, shown in the run's summary
 */

/**
 * first start setup steps, "later" and "declined" are answers, the rest survive a reload
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
 * @return {boolean}
 */
export function loggedIn(){
    return document.querySelector("#signedInHeaderBar") !== null;
}

/**
 * @param {number} [ms]
 * @return {Promise<import("./metrics.js").FrameStats>}
 */
function measure(ms = SAMPLE_MS){
    return new Promise((resolve, reject) => {
        const recorder = new FrameRecorder();
        const start = performance.now();
        // rAF never fires on a page that stopped drawing, don't hang the run
        const watchdog = setTimeout(() => reject(new Error("the game stopped drawing frames")), ms + 5000);
        const frame = () => {
            const now = performance.now();
            recorder.frame(now);
            if (now - start < ms){
                requestAnimationFrame(frame);
                return;
            }
            clearTimeout(watchdog);
            resolve(recorder.stats(8) ?? { frames: 0, seconds: 0, fps: 0, meanMs: 0, p50: 0, p95: 0, p99: 0, p999: 0, maxMs: 0, hitches: 0, hitchesPerSec: 0 });
        };
        requestAnimationFrame(frame);
    });
}

/**
 * sets a kute setting, settings page doesn't need to be open
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
 * @return {string} stored value in player words
 */
function readable(value){
    if (value === null || value === undefined) return "default";
    if (String(value) === "true") return "on";
    if (String(value) === "false") return "off";
    return String(value);
}

/**
 * test overrides, e.g. `--autodetect-dev=hz:600,battery` to fake a weak PC
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
 * runs client configs in bench processes, host hides the game page meanwhile
 *
 * @param {{config: string, label: string}[]} configs
 * @return {Promise<import("./decide.js").ClientResult[]>}
 */
async function measureClient(configs){
    /** @type {any[]|null} */
    const raw = await request(`run-bench-matrix ${JSON.stringify(configs.map((entry) => entry.config))}`, "benchMatrix", 20000 * configs.length);
    return configs.map((entry, index) => {
        const result = raw?.[index];
        // host drops "limit=auto" without an uncapped result to base it on, that row ran uncapped, treat as unavailable
        const ranUncapped = entry.config.includes("limit=") && !(Number(result?.config?.limit) > 0);
        const stats = ranUncapped ? undefined : result?.page?.stats;
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
            taskDelayP99: result?.page?.otherTasks?.p99 ?? null,
            limit: result?.config?.limit ?? 0,
        };
    });
}

/**
 * same config with "limit=auto" pinned to the cap it really used, so a confirm matrix doesn't fall back to 30
 *
 * @param {import("./decide.js").ClientResult} row
 * @return {{config: string, label: string}}
 */
function replayConfig(row){
    const limit = Number(row.limit) || 0;
    return { config: limit > 0 ? row.config.replace("limit=auto", `limit=${limit}`) : row.config, label: row.label };
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
        // nearly opaque, the game looks weird while measuring
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
     * question with buttons for the setup, each choice closes the panel itself if it wants to
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
            // raw numbers for bug reports
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
     * lets the host's spawn click through to the game
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

    undo(){
        const state = readState();
        if (!state?.undoable){
            kute.showNotification("Nothing to undo", false, 3);
            return;
        }
        // some restored values only apply after a reload (preset stuff) or restart (hook)
        const reloadIds = new Set(game.SETTINGS.filter((setting) => setting.needsReload).map((setting) => setting.id));
        const needsReload = Object.entries(state.snapshot.game).some(([id, value]) => reloadIds.has(id) && value !== null && game.read(id) !== value);
        const needsRestart = state.snapshot.client.hardFlip !== undefined && kute.settings.data.hardFlip !== state.snapshot.client.hardFlip;
        this.restore(state.snapshot);
        state.undoable = false;
        let line = "Your previous settings are back.";
        if (needsReload) line = "Your previous settings are back, the game reloads once to apply them.";
        if (needsRestart) line += " Restart Kute to finish.";
        state.summary = { title: "Undone", line, details: [], changed: false, needsRestart };
        writeState(state);
        kute.showNotification(`Auto-detect undone. ${line.replace("Your previous settings are back", "Your settings are back")}`, false, 5);
        if (needsReload) setTimeout(() => location.reload(), 1200);
    }

    // after a settings import, undo would overwrite the imported values
    dropUndo(){
        const state = readState();
        if (!state?.undoable) return;
        state.undoable = false;
        writeState(state);
    }

    showLast(){
        const state = readState();
        if (!state?.summary){
            kute.showNotification("Auto-detect has not run yet", false, 3);
            return;
        }
        new Panel().result(state.summary, { onUndo: state.undoable ? () => this.undo() : undefined, report: state.report });
    }

    /**
     * @param {{snapshot?: RunState["snapshot"], details?: string[]}} [options] what the setup already changed and its pre-setup snapshot
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
        // setup ends here, otherwise a cancel would restore its step and rerun on next load
        if (previous){
            delete previous.wizard;
            delete previous.wizardDetails;
        }
        // undo goes to pre-preset, measurements start from post-preset. don't mix them
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

        const venue = { inMatch: false };
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
            // a no-op run keeps the previous run's undo
            if (!outcome.summary.changed && previous?.undoable){
                state.snapshot = previous.snapshot;
                state.undoable = true;
            }
            delete state.previous;
            delete state.baseline;
            // leaving the match reloads, summary shows after
            state.showSummary = true;
            writeState(state);
            panel.progress("Leaving the test match", 1);
            document.exitPointerLock();
            await sleep(800);
            location.href = HOME;
        }
        catch (error){
            abandon();
            const message = error instanceof Error ? error.message : String(error);
            kute.showNotification(`Auto-detect stopped: ${message}`, false, 7);
        }
        finally {
            document.removeEventListener("keydown", onKey, true);
            window.chrome.webview.postMessage("throttle, menu");
            this.running = false;
        }
    }

    /**
     * @param {Panel} panel
     * @param {RunState} state
     * @param {{inMatch: boolean}} venue
     * @param {string[]} earlier what the setup changed before the run
     * @return {Promise<{summary: Summary, report: Report}|null>} null when cancelled
     */
    async run(panel, state, venue, earlier = []){
        const started = performance.now();
        const dev = devOverrides();
        const baseline = state.baseline ?? state.snapshot;

        panel.progress("Reading your hardware", 0.02);
        const specs = await request("get-specs", "specs");
        // hot updated bundle on an old exe
        if (specs === null) throw new Error("this needs a newer version of the client");
        /** @type {{hz: number, hostsWindow: boolean}[]} */
        const displays = specs.displays ?? [];
        const display = displays.find((entry) => entry.hostsWindow) ?? displays[0];
        const hz = dev.hz ?? (display?.hz > 1 ? display.hz : 60);
        /** @type {{name: string, software: boolean, vramMb: number}[]} */
        const gpus = (specs.gpus ?? []).filter((/** @type {{software: boolean}} */ gpu) => !gpu.software);
        const gpuName = [...gpus].sort((a, b) => b.vramMb - a.vramMb)[0]?.name ?? "unknown graphics card";

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
            // confirm with a second run before changing anything
            panel.progress("Confirming the client test", 0.04);
            const [currentAgain, bestAgain] = await measureClient([replayConfig(clientPlan.current), replayConfig(clientPlan.best)]);
            const confirmed = decideClient([currentAgain, bestAgain], settingsNow, hz);
            if (confirmed.change) clientNote = `"${clientPlan.best.label}" measured clearly better than "${clientPlan.current.label}", twice.`;
            else {
                clientNote = `"${clientPlan.best.label}" looked better at first, but not when measured again. Nothing changed there.`;
                clientPlan = { ...clientPlan, change: false };
            }
            // match by label, the replay pinned "limit=auto" to a number
            client = client.map((row) => (row.label === bestAgain.label && bestAgain.fps > 0 ? { ...row, p99: Math.max(row.p99, bestAgain.p99), low: Math.min(row.low, bestAgain.low) } : row));
        }
        if (this.cancelled) return null;

        panel.progress("Opening a private test match", 0.05);
        panel.clickThrough(true);
        const room = await hostLobby();
        let joined = false;
        if (room){
            panel.progress("Joining the test match", 0.1);
            joined = await spawn(room);
        }
        panel.clickThrough(false);
        if (!joined){
            window.closWind?.();
            throw new Error("could not open a private test match (is a host slot free?)");
        }
        venue.inMatch = true;
        // bail on redirect, kick or disconnect
        const stillInRoom = () => {
            if (!inRoom(room)) throw new Error("left the private test match");
        };
        if (this.cancelled) return null;

        window.chrome.webview.postMessage("throttle, off");
        const fpsLimitBefore = Number(kute.settings.data.gameFpsLimit) || 0;
        const frameCapBefore = Number(baseline.game[game.GAME_FRAME_CAP]) || 0;
        if (fpsLimitBefore > 0) applyClient("gameFpsLimit", 0);
        if (frameCapBefore > 0) game.write(game.GAME_FRAME_CAP, "0");
        // assets and shaders still loading
        await sleep(2500);
        // again, pointer lock posts the in-game throttle and can race the first "off"
        window.chrome.webview.postMessage("throttle, off");
        await sleep(300);

        window.chrome.webview.postMessage("bring-to-front");
        stillInRoom();
        panel.progress("Measuring your current settings", 0.15);
        // first call just starts a fresh window in the hook
        await request("get-present-intervals", "presentIntervals");
        const presentsSince = performance.now();
        const first = await measure();
        const repeats = [first.fps, (await measure()).fps, (await measure()).fps];
        const presentIntervals = (await request("get-present-intervals", "presentIntervals")) || null;
        // counted presents in this window, never "get-present" (moving avg, freezes when the hook goes quiet).
        // no answer or a full ring = unknown (0)
        const presentSeconds = (performance.now() - presentsSince) / 1000;
        const presentCount = Number(presentIntervals?.samples) || 0;
        const presentFps = presentCount > 0 && presentCount < PRESENT_RING ? Math.round(presentCount / presentSeconds) : 0;
        // loop fps over the same window, for the health check
        const windowFps = repeats.reduce((sum, fps) => sum + fps, 0) / repeats.length;
        const base = first;
        const noise = (Math.max(...repeats) - Math.min(...repeats)) / Math.max(1, Math.max(...repeats));
        // every unchanged sample of the run, the median is what the PC holds (warmup and heat skew the ends)
        const baselines = [...repeats];
        /**
         * @return {number}
         */
        const baselineFps = () => {
            const sorted = [...baselines].sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length / 2)];
        };
        if (this.cancelled) return null;

        // compare against the mean of the samples before and after, cancels heat drift
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
            if (setting.fightOnly){
                row.note = "not tested (only costs in a fight)";
                continue;
            }
            if (current === null){
                row.note = "value unknown";
                continue;
            }
            if (this.cancelled) return null;
            stillInRoom();

            panel.progress(`Measuring ${setting.label}`, 0.2 + (0.6 * live.indexOf(setting)) / live.length);
            const flipped = game.opposite(current);
            const { ratio, steady, raw } = await compare(() => game.write(setting.id, flipped), () => game.write(setting.id, current));
            // always stored as what the cheap value gains
            row.gain = flipped === cheap ? ratio : 1 / Math.max(0.01, ratio);
            row.steady = steady;
            row.raw = raw;
        }
        if (this.cancelled) return null;

        // settings we'd change get measured twice, the lower gain counts
        if (baselineFps() < hz * TARGET_REFRESH_MULTIPLE * HEADROOM){
            for (const row of settings){
                if (row.gain === null || !row.steady || row.current === row.cheap || row.gain < SIGNIFICANT_SETTING) continue;
                if (this.cancelled) return null;
                stillInRoom();
                panel.progress(`Confirming ${row.label}`, 0.8);
                const { ratio, steady } = await compare(() => game.write(row.id, row.cheap), () => game.write(row.id, row.current));
                row.confirmGain = ratio;
                row.gain = Math.min(row.gain, ratio);
                row.steady = steady;
            }
        }

        stillInRoom();
        panel.progress("Checking the graphics card", 0.82);
        const resolution = Number(baseline.game[game.RESOLUTION]) || 1;
        const half = await compare(
            () => game.write(game.RESOLUTION, String(Math.max(0.1, resolution * 0.5))),
            () => game.write(game.RESOLUTION, String(resolution)),
        );
        // fewer pixels can't be slower, a ratio well below 1 is a hiccup
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

        panel.progress("Applying", 0.88);
        /** @type {string[]} */
        const details = [...earlier];
        /**
         * applied after the final measurement, a cap here would drag the resolution loop to its floor
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

        let finalFps = null;
        if (gameChanged || plan.tuneResolution){
            await sleep(SETTLE_MS);
            finalFps = (await measure()).fps;
        }

        // gpu bound and still short: fps follows pixel count, estimate once then verify
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
            },
        };
    }

    /**
     * stores the setup step, keeps the last run's result for "Last Auto-Detect Result"
     *
     * @param {WizardStage} wizard
     * @param {RunState["snapshot"]} [snapshot]
     * @param {string[]} [details] what the setup changed before its run
     */
    remember(wizard, snapshot, details){
        const state = readState() ?? { status: /** @type {const} */ ("prompted"), at: Date.now(), snapshot: { client: {}, game: {} } };
        writeState({ ...state, at: Date.now(), wizard, ...(snapshot ? { snapshot } : {}), ...(details ? { wizardDetails: details } : {}) });
    }

    // once per client start at most
    offer(){
        if (this.running || sessionStorage.getItem(ASKED_KEY)) return;
        // already in a match, ask once back in the menu
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
     * header bar says logged out for 5+ s after a load, wait if there's a token
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
     * setup entry (also the settings button): login if needed, then settings source
     *
     * @param {Panel} [panel] reuse to avoid flicker
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
     * @param {Panel} [panel]
     */
    askLogin(panel = new Panel()){
        // login reloads the page
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

    // for logins that don't reload, otherwise resume() picks it up
    waitForLogin(){
        const until = Date.now() + LOGIN_TIMEOUT_MS;
        const timer = setInterval(() => {
            if (loggedIn()){
                clearInterval(timer);
                this.askSettings();
                return;
            }
            // giving up leaves "login" stored, asks again next start
            if (Date.now() > until) clearInterval(timer);
        }, 1000);
    }

    /**
     * asked every time
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

    afterImport(){
        if (readState()?.wizard !== "import") return;
        // snapshot after the import so undo keeps the imported values. stored first, the import may reload
        const snapshot = this.snapshot();
        this.remember("run", snapshot, []);
        setTimeout(() => {
            if (readState()?.wizard === "run") this.start({ snapshot });
        }, 1500);
    }

    // most of the preset only applies after a reload
    applyPreset(){
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

    // page start: clean up a previous page, continue the setup, or offer on a first start
    resume(){
        const state = readState();
        if (state?.status === "running"){
            // closed or crashed mid run
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
        // reload after preset or import, account isn't back yet this early
        if (state?.wizard === "run"){
            setTimeout(async() => {
                if (await this.signedIn()) this.start({ snapshot: state.snapshot, details: state.wizardDetails ?? [] });
            }, RESUME_RUN_DELAY_MS);
            return;
        }
        // reload mid setup, "import" also lands here when the popup was closed without importing
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
