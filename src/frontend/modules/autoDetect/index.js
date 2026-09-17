import panelHtml from "../../components/autoDetect.html";
import { kute } from "../../client.js";
import { checkCompMode } from "../../utils.js";
import { FrameRecorder } from "./metrics.js";
import { decide, decideClient, HEADROOM, MIN_RESOLUTION, SIGNIFICANT_SETTING, TARGET_REFRESH_MULTIPLE } from "./decide.js";
import * as game from "./gameSettings.js";

// One click auto-detect. The same run on every PC. First the client itself: the host starts one bench
// process per client configuration (swapchain hook, FPS cap, CPU throttle) while the game page is hidden.
// Then the game: an empty private test match (it needs an account), a baseline, every live render setting
// flipped and measured on this PC, the resolution scale probed. decide.js applies what was measured to help. Everything that gets touched is snapshotted first
// and can be undone, and every number ends up in the Advanced view. Nothing runs on its own: a first
// start only tells the player where the button is.

const STORAGE_KEY = "kute_autodetect";
const SAMPLE_MS = 900;
const SETTLE_MS = 450;
// samples of the same settings right before and after a measurement may differ by this share. beyond it
// something else moved (a hitch, a shader compile) and the number is not used
const STEADY_SPREAD = 0.08;
const CLIENT_KEYS = ["gameFpsLimit", "throttle", "hardFlip"];
// the client configurations every run measures, the least restrictive first. "limit=auto" is a cap a bit
// below what the first one reaches, the classic advice against a graphics card that cannot keep up
const CLIENT_CONFIGS = [
    { config: "hook=1", label: "Hook on, uncapped" },
    { config: "hook=0", label: "Hook off, uncapped" },
    { config: "hook=1,limit=auto", label: "Hook on, FPS cap" },
    { config: "hook=0,limit=auto", label: "Hook off, FPS cap" },
    { config: "hook=1,throttle=1.5", label: "Hook on, CPU throttle" },
];
// the private test match: Burg, small and the same for everyone
const LOBBY_MAP = "gameMap0";
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
 * @property {{client: Record<string, any>, game: Record<string, string|null>}} snapshot
 * @property {Summary} [summary]
 * @property {Report} [report]
 * @property {boolean} [showSummary] Set across the page load that ends a run
 * @property {boolean} [undoable] The snapshot holds values that differ from what is set now
 * @property {RunState|null} [previous] While running: the state to fall back to, it may still hold an undo
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
 * Posts a message to the host and resolves with the reply's field.
 *
 * @param {string} message
 * @param {string} key
 * @param {number} [timeoutMs]
 * @return {Promise<any>} null when the host does not answer (an older exe)
 */
function request(message, key, timeoutMs = 2000){
    return new Promise((resolve) => {
        const pending = { timer: 0 };
        /**
         * @param {MessageEvent} event
         */
        const handler = (event) => {
            if (event.data?.[key] === undefined) return;
            clearTimeout(pending.timer);
            window.chrome.webview.removeEventListener("message", handler);
            resolve(event.data[key]);
        };
        pending.timer = setTimeout(() => {
            window.chrome.webview.removeEventListener("message", handler);
            resolve(null);
        }, timeoutMs);
        window.chrome.webview.addEventListener("message", handler);
        window.chrome.webview.postMessage(message);
    });
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
 * @return {Partial<KrunkerGameActivity> & {id?: string}}
 */
function activity(){
    try {
        return window.getGameActivity?.() ?? {};
    }
    catch {
        return {};
    }
}

/**
 * Hosts a private match through Krunker's own host window. The game switches rooms inside the page,
 * so success shows up as a new custom game in the activity, not as a page load.
 *
 * @return {Promise<boolean>}
 */
async function hostLobby(){
    if (typeof window.openHostWindow !== "function" || typeof window.createPrivateRoom !== "function") return false;
    const previousId = activity().id;
    // the game does not always take the request, for one while the match behind the menu is ending
    for (let attempt = 0; attempt < 4; attempt++){
        window.openHostWindow(false, 0);
        await sleep(800);
        window.windows[7]?.switchTab?.(0);
        await sleep(300);
        const maps = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll("#windowHolder input[id^=gameMap]")]);
        if (maps.length === 0) return false;
        for (const map of maps){
            if (map.checked !== (map.id === LOBBY_MAP)) map.click();
        }
        window.createPrivateRoom();
        for (let i = 0; i < 32; i++){
            await sleep(250);
            const now = activity();
            if (now.custom && now.id && now.id !== previousId && now.map) return true;
        }
        window.closWind?.();
        await sleep(1500);
    }
    return false;
}

/**
 * @return {boolean}
 */
function spawned(){
    const instructions = document.querySelector("#instructions");
    return Boolean(document.pointerLockElement) || (instructions !== null && getComputedStyle(instructions).display === "none");
}

/**
 * Clicks into the match. Pointer lock needs a trusted click, so the host sends it (a DOM click() does nothing).
 *
 * @return {Promise<boolean>}
 */
async function spawn(){
    for (let i = 0; i < 40 && !(activity().map && document.querySelector("#instructions")); i++) await sleep(250);
    await sleep(500);
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight / 2);
    for (let attempt = 0; attempt < 3 && !spawned(); attempt++){
        window.chrome.webview.postMessage(`click, ${x}, ${y}`);
        await sleep(1200);
    }
    await sleep(800);
    return spawned();
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
        const stats = raw?.[index]?.page?.stats;
        return {
            config: entry.config,
            label: entry.label,
            hook: !entry.config.includes("hook=0"),
            capped: entry.config.includes("limit="),
            throttled: entry.config.includes("throttle="),
            fps: stats?.fps ?? 0,
            p99: stats?.p99 ?? 0,
            low: stats?.p99 > 0 ? 1000 / stats.p99 : 0,
        };
    });
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
        test match. They were not tested and not changed.</p>
        <p>${kute.settings.data.telemetry === false
        ? "Sharing is off, these numbers stayed on this PC."
        : "These numbers (and nothing else) were shared to improve auto-detect. Settings, About, Share Auto-Detect Results turns that off."}</p>`;
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
     * @return {Promise<void>}
     */
    async start(){
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
        /** @type {RunState} */
        const state = { status: "running", at: Date.now(), snapshot: this.snapshot(), previous };
        writeState(state);

        const panel = new Panel();
        /**
         * @param {KeyboardEvent} event
         */
        const onKey = (event) => {
            if (event.key === "Escape") this.cancelled = true;
        };
        document.addEventListener("keydown", onKey, true);

        // whoever cleans up has to know whether the page is still the menu
        const venue = { inMatch: false };
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
            const outcome = await this.run(panel, state, venue);
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
            // leaving the test match is a page load, the summary comes up after it
            state.showSummary = true;
            writeState(state);
            // shared unless the player switched it off: the measurements, no account, no ids (the host checks the setting too)
            if (kute.settings.data.telemetry !== false){
                window.chrome.webview.postMessage(`telemetry ${JSON.stringify({ kute: kute.version, ...outcome.report })}`);
            }
            panel.progress("Leaving the test match", 1);
            document.exitPointerLock();
            await sleep(800);
            location.href = HOME;
        }
        catch (error){
            abandon();
            kute.showNotification(`Auto-detect stopped: ${error instanceof Error ? error.message : error}`, false, 7);
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
     * @param {{inMatch: boolean}} venue
     * @return {Promise<{summary: Summary, report: Report}|null>} null when cancelled
     */
    async run(panel, state, venue){
        const started = performance.now();
        const dev = devOverrides();

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
            const [currentAgain, bestAgain] = await measureClient([clientPlan.current, clientPlan.best]);
            const confirmed = decideClient([currentAgain, bestAgain], settingsNow, hz);
            if (confirmed.change) clientNote = `"${clientPlan.best.label}" measured clearly better than "${clientPlan.current.label}", twice.`;
            else {
                clientNote = `"${clientPlan.best.label}" looked better at first, but not when measured again. Nothing changed there.`;
                clientPlan = { ...clientPlan, change: false };
            }
            client = client.map((row) => (row.config === bestAgain.config && bestAgain.fps > 0 ? { ...row, p99: Math.max(row.p99, bestAgain.p99), low: Math.min(row.low, bestAgain.low) } : row));
        }
        if (this.cancelled) return null;

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
        if (this.cancelled) return null;

        // measure the game itself: no throttle, no limiter of ours, no frame cap of the game
        window.chrome.webview.postMessage("throttle, off");
        const fpsLimitBefore = Number(kute.settings.data.gameFpsLimit) || 0;
        const frameCapBefore = Number(state.snapshot.game[game.GAME_FRAME_CAP]) || 0;
        if (fpsLimitBefore > 0) applyClient("gameFpsLimit", 0);
        if (frameCapBefore > 0) game.write(game.GAME_FRAME_CAP, "0");
        // the first seconds of a match still stream assets and compile shaders
        await sleep(2500);

        panel.progress("Measuring your current settings", 0.15);
        const first = await measure();
        const repeats = [first.fps, (await measure()).fps, (await measure()).fps];
        const presentFps = Number(await request("get-present", "presentFps")) || 0;
        const base = first;
        const baseFps = Math.max(...repeats);
        const noise = (Math.max(...repeats) - Math.min(...repeats)) / Math.max(1, baseFps);
        if (this.cancelled) return null;

        // every measurement sits between two samples of the unchanged settings and is compared with their
        // mean. a laptop gets slower by a third while it warms up, and this is what takes that drift out
        let reference = repeats[2];
        /**
         * @param {() => void} apply
         * @param {() => void} revert
         * @return {Promise<{ratio: number, steady: boolean}>}
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
            const mean = (before + after) / 2;
            return { ratio: changed.fps / Math.max(1, mean), steady: Math.abs(before - after) / Math.max(1, mean) <= STEADY_SPREAD };
        };

        /** @type {MeasuredSetting[]} */
        const settings = [];
        const live = game.SETTINGS.filter((setting) => !setting.needsReload && !setting.fightOnly);
        for (const setting of game.SETTINGS){
            const current = state.snapshot.game[setting.id];
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
            const { ratio, steady } = await compare(() => game.write(setting.id, flipped), () => game.write(setting.id, current));
            // always stored as "what the cheap value gains", whichever direction was measured
            row.gain = flipped === cheap ? ratio : 1 / Math.max(0.01, ratio);
            row.steady = steady;
        }
        if (this.cancelled) return null;

        // one measurement is enough for the diagnostics, not for changing something: a setting that is about
        // to be switched gets measured a second time, and the lower of the two numbers counts
        if (baseFps < hz * TARGET_REFRESH_MULTIPLE * HEADROOM){
            for (const row of settings){
                if (row.gain === null || !row.steady || row.current === row.cheap || row.gain < SIGNIFICANT_SETTING) continue;
                if (this.cancelled) return null;
                panel.progress(`Confirming ${row.label}`, 0.8);
                const { ratio, steady } = await compare(() => game.write(row.id, row.cheap), () => game.write(row.id, row.current));
                row.gain = Math.min(row.gain, ratio);
                row.steady = steady;
            }
        }

        panel.progress("Checking the graphics card", 0.82);
        const resolution = Number(state.snapshot.game[game.RESOLUTION]) || 1;
        const half = await compare(
            () => game.write(game.RESOLUTION, String(Math.max(0.1, resolution * 0.5))),
            () => game.write(game.RESOLUTION, String(resolution)),
        );
        // half the pixels cannot be slower, a number like that caught a hiccup
        const halfResolutionGain = half.steady && half.ratio > 0.92 ? half.ratio : null;
        const drift = reference / Math.max(1, repeats[0]);
        if (this.cancelled) return null;

        const plan = decide(
            { baseFps, p50: base.p50, p99: base.p99, presentFps, halfResolutionGain, settings },
            {
                hz,
                onBattery: dev.battery ?? Boolean(specs.onBattery),
                throttle: Number(state.snapshot.client.throttle) || 1,
                gameFpsLimit: fpsLimitBefore,
                gameFrameCap: frameCapBefore,
                hardFlip: settingsNow.hardFlip,
                client: clientPlan.change ? clientPlan.best : null,
            },
        );

        panel.progress("Applying", 0.88);
        /** @type {string[]} */
        const details = [];
        let limitChanged = false;
        let gameChanged = false;
        let needsRestart = false;
        for (const change of plan.changes){
            if (change.scope === "game"){
                details.push(`<b>${change.label}</b>: ${readable(state.snapshot.game[change.id])} → ${readable(change.value)} (${change.reason})`);
                game.write(change.id, String(change.value));
                if (change.id !== game.GAME_FRAME_CAP) gameChanged = true;
            }
            else {
                details.push(`<b>${change.label}</b>: ${readable(state.snapshot.client[change.id])} → ${readable(change.value)} (${change.reason})`);
                applyClient(change.id, change.value);
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

        // the resolution scale only goes down when half the pixels measurably helped and the goal is still
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
     * Start of the page: finish or clean up what a previous page left. A first start (or cleared storage)
     * only points the player to the button, nothing is measured or changed without being asked.
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
        if (state) return;

        setTimeout(() => {
            if (this.running || document.pointerLockElement) return;
            writeState({ status: "prompted", at: Date.now(), snapshot: { client: {}, game: {} } });
            const canRun = loggedIn();
            new Panel().result(
                {
                    title: "Set Kute up for this PC?",
                    line: canRun
                        ? "Auto-detect measures your PC in a private test match for about a minute and then sets up the game for it. You can undo it, and run it any time from Settings, Client, Auto-Detect Best Settings. The measurements (hardware names and numbers, nothing about you) are shared to improve it, which you can switch off under About."
                        : "Auto-detect measures your PC in a private test match and then sets up the game for it. It needs an account: log in, then open Settings, Client and press Auto-Detect Best Settings. The measurements (hardware names and numbers, nothing about you) are shared to improve it, which you can switch off under About.",
                    details: [],
                    changed: false,
                },
                { onRun: canRun ? () => this.start() : undefined },
            );
        }, 5000);
    }
}

const autoDetect = new AutoDetect();
kute.autoDetect = autoDetect;
autoDetect.resume();
