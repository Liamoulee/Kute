import panelHtml from "../../components/autoDetect.html";
import { kute } from "../../client.js";
import { checkCompMode } from "../../utils.js";
import { FrameRecorder } from "./metrics.js";
import { decide, expectedFps, MIN_RESOLUTION, TARGET_REFRESH_MULTIPLE } from "./decide.js";
import * as game from "./gameSettings.js";

// One click auto-detect: measures the real Krunker renderer, decides (decide.js) and applies game and
// client settings. One sample behind the menu settles it for a PC that is far above its goal. Any other
// PC is measured in an empty private match, because on a weak processor the menu runs far slower than
// the game and says little about it. Everything that gets touched is snapshotted first and can be
// undone. Runs on its own (menu only) on the first start and after the storage was cleared.

const STORAGE_KEY = "kute_autodetect";
const SAMPLE_MS = 1200;
const SETTLE_MS = 450;
// two samples of the same settings may differ by this share before the scene counts as too busy to probe
const STEADY_SPREAD = 0.15;
// this far above the goal the graphics card probes are skipped, their outcome could not change anything
const COMFORTABLE = 1.3;
const CLIENT_KEYS = ["gameFpsLimit", "throttle"];
// the private lobby of the fine tune run: Burg, small and the same for everyone
const LOBBY_MAP = "gameMap0";
const HOME = "https://krunker.io/";

/**
 * @typedef {import("./decide.js").Change} Change
 */

/**
 * @typedef {object} RunState
 * @property {"running"|"done"} status
 * @property {number} at
 * @property {{client: Record<string, any>, game: Record<string, string|null>}} snapshot
 * @property {{title: string, line: string, details: string[], changed: boolean}} [summary]
 * @property {boolean} [showSummary] Set across the reload that applies reload-only game settings
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
 * Test overrides from the launch arguments, e.g. `--autodetect-dev=hz:600,battery,gpu`. A strong PC reaches
 * every goal, so the weak PC branches need a pretend display (hz), battery or graphics card limit (gpu).
 *
 * @return {{hz?: number, battery?: boolean, gpu?: boolean, laptop?: boolean}}
 */
function devOverrides(){
    const match = /--autodetect-dev=(\S+)/.exec(kute.launchArgs ?? "");
    /** @type {{hz?: number, battery?: boolean, gpu?: boolean, laptop?: boolean}} */
    const overrides = {};
    for (const part of match?.[1].split(",") ?? []){
        const [key, value] = part.split(":");
        if (key === "hz") overrides.hz = Number(value);
        if (key === "battery") overrides.battery = true;
        if (key === "gpu") overrides.gpu = true;
        if (key === "laptop") overrides.laptop = true;
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
 * Hosts a private lobby through Krunker's own host window. The game switches rooms inside the page,
 * so success shows up as a new custom game in the activity, not as a page load.
 *
 * @return {Promise<boolean>}
 */
async function hostLobby(){
    if (typeof window.openHostWindow !== "function" || typeof window.createPrivateRoom !== "function") return false;
    const previousId = activity().id;
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
    for (let i = 0; i < 80; i++){
        await sleep(250);
        const now = activity();
        if (now.custom && now.id && now.id !== previousId && now.map) return true;
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

class Panel {
    constructor(){
        document.querySelector("#adPanelHost")?.parentElement?.remove();
        this.overlay = document.createElement("div");
        // nearly opaque: the probes change the resolution behind it
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
     * Switches from the progress view to the result.
     *
     * @param {NonNullable<RunState["summary"]>} summary
     * @param {() => void} onUndo
     */
    result(summary, onUndo){
        this.element("adTitle").textContent = summary.title;
        this.element("adStatus").textContent = summary.line;
        this.element("adBar").style.display = "none";
        this.element("adHint").style.display = "none";
        this.element("adActions").style.display = "flex";
        this.element("adUndo").style.display = summary.changed ? "" : "none";
        this.element("adDetailsButton").style.display = summary.details.length > 0 ? "" : "none";
        this.element("adDetails").innerHTML = summary.details.map((line) => `<li>${line}</li>`).join("");
        this.element("adDetailsButton").onclick = () => {
            const details = this.element("adDetails");
            details.style.display = details.style.display === "block" ? "none" : "block";
        };
        this.element("adOk").onclick = () => this.close();
        this.element("adUndo").onclick = () => {
            this.close();
            onUndo();
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
     * @return {boolean} Whether a value changed that Krunker only applies after a reload
     */
    restore(snapshot){
        const reloadOnly = new Set(game.TIERS.flatMap((tier) => tier.settings.filter((setting) => setting.needsReload).map((setting) => setting.id)));
        let needsReload = false;
        game.resetCache();
        for (const [id, value] of Object.entries(snapshot.game)){
            if (value === null || game.read(id) === value) continue;
            game.write(id, value);
            if (reloadOnly.has(id)) needsReload = true;
        }
        for (const [id, value] of Object.entries(snapshot.client)){
            if (value !== undefined && kute.settings.data[id] !== value) applyClient(id, value);
        }
        return needsReload;
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
        const needsReload = this.restore(state.snapshot);
        state.undoable = false;
        state.summary = { title: "Undone", line: "Your previous settings are back.", details: [], changed: false };
        // the reload would swallow a notification, so the panel confirms it afterwards
        state.showSummary = needsReload;
        writeState(state);
        if (needsReload) location.reload();
        else kute.showNotification("Auto-detect undone, your previous settings are back", false, 4);
    }

    /**
     * @param {boolean} [automatic] True for the first start run: it stays quiet when it cannot run and never
     * leaves the menu, nobody asked for their pointer to be taken into a match
     * @return {Promise<void>}
     */
    async start(automatic = false){
        if (this.running) return;
        if (document.pointerLockElement || checkCompMode()){
            if (!automatic) kute.showNotification("Open the menu outside of a competitive match first", false, 4);
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

        // run() moves into a test lobby when it has to, and whoever cleans up needs to know
        const venue = { inMatch: false };
        try {
            const summary = await this.run(panel, state, venue, !automatic);
            if (venue.inMatch) document.exitPointerLock();
            if (summary === null){
                this.restore(state.snapshot);
                // an automatic run that was cancelled must not come back on every start
                writeState(previous ?? { status: "done", at: Date.now(), snapshot: state.snapshot });
                panel.close();
                if (venue.inMatch) location.href = HOME;
                return;
            }
            state.status = "done";
            state.summary = summary.summary;
            state.undoable = summary.summary.changed;
            // a run that changed nothing must not cost the player the undo of the run before it
            if (!summary.summary.changed && previous?.undoable){
                state.snapshot = previous.snapshot;
                state.undoable = true;
            }
            delete state.previous;
            // leaving the test lobby is a page load as well, the summary comes up after it
            if (summary.needsReload || venue.inMatch){
                state.showSummary = true;
                writeState(state);
                panel.progress(venue.inMatch ? "Leaving the test lobby" : "Reloading the game to apply the new settings", 1);
                await sleep(1200);
                if (venue.inMatch) location.href = HOME;
                else location.reload();
                return;
            }
            writeState(state);
            panel.result(summary.summary, () => this.undo());
        }
        catch (error){
            this.restore(state.snapshot);
            if (previous) writeState(previous);
            else localStorage.removeItem(STORAGE_KEY);
            panel.close();
            if (venue.inMatch){
                document.exitPointerLock();
                location.href = HOME;
            }
            kute.showNotification(`Auto-detect failed: ${error}`, false, 6);
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
     * @param {{inMatch: boolean}} venue Set to the match once the run had to leave the menu
     * @param {boolean} allowLobby Whether the run may open a private test lobby
     * @return {Promise<{summary: NonNullable<RunState["summary"]>, needsReload: boolean}|null>} null when cancelled
     */
    async run(panel, state, venue, allowLobby){
        const dev = devOverrides();

        panel.progress("Reading your hardware", 0.05);
        const specs = await request("get-specs", "specs");
        // the bundle can be newer than the exe (hot update). an exe without these queries also cannot
        // switch the menu throttle off, and a throttled measurement would lower settings for no reason
        if (specs === null) throw new Error("this needs a newer version of the client");
        /** @type {{hz: number, hostsWindow: boolean}[]} */
        const displays = specs.displays ?? [];
        const display = displays.find((entry) => entry.hostsWindow) ?? displays[0];
        const hz = dev.hz ?? (display?.hz > 1 ? display.hz : 60);
        /** @type {{name: string, software: boolean, vramMb: number}[]} */
        const gpus = (specs.gpus ?? []).filter((/** @type {{software: boolean}} */ gpu) => !gpu.software);
        const gpuName = [...gpus].sort((a, b) => b.vramMb - a.vramMb)[0]?.name ?? "your PC";
        const laptop = dev.laptop ?? Boolean(specs.laptop);
        const goal = hz * TARGET_REFRESH_MULTIPLE;

        // measure the page itself: no menu throttle, no limiter of ours, no frame cap of the game
        window.chrome.webview.postMessage("throttle, off");
        const fpsLimitBefore = Number(kute.settings.data.gameFpsLimit) || 0;
        const frameCapBefore = Number(state.snapshot.game[game.GAME_FRAME_CAP]) || 0;
        if (fpsLimitBefore > 0) applyClient("gameFpsLimit", 0);
        if (frameCapBefore > 0) game.write(game.GAME_FRAME_CAP, "0");
        await sleep(SETTLE_MS + 300);
        if (this.cancelled) return null;

        // half the pixels: faster means the GPU is the limit. twice the pixels: no slower means it is far from it.
        // the current settings are sampled before and after the probe: the better of the two is the honest
        // baseline (a hiccup can only make a sample slower, never faster), and how far they are apart says
        // whether the scene holds still enough to compare anything. a busy scene swings by a factor of two
        // within seconds (seen in a live public match), and a probe read against that is pure noise
        const resolution = Number(state.snapshot.game[game.RESOLUTION]) || 1;
        panel.progress("Measuring your current settings", 0.1);
        let base = await measure();
        let lowRes = base;
        let presentFps = 0;
        // a PC that is far above the goal gets no changes whatever limits it, so it is done after one sample
        let comfortable = expectedFps(base.fps, { inMatch: false, laptop }) >= goal * COMFORTABLE;

        // everyone else is measured where it counts. the menu of a weak PC runs at half the speed of its
        // matches, and deciding from that would take effects away from players who do not need to lose them
        if (!comfortable && allowLobby && !this.cancelled){
            panel.progress("Opening a private test lobby", 0.12);
            panel.clickThrough(true);
            let joined = await hostLobby();
            if (joined){
                panel.progress("Joining the test lobby", 0.16);
                joined = await spawn();
            }
            panel.clickThrough(false);
            if (joined){
                venue.inMatch = true;
                // clicking in switched the client to its in-game throttle
                window.chrome.webview.postMessage("throttle, off");
                await sleep(1000);
                base = await measure();
                lowRes = base;
                comfortable = expectedFps(base.fps, { inMatch: true, laptop }) >= goal * COMFORTABLE;
            }
            // no account, no free host slot or a changed host window: the menu still gives a result
            else window.closWind?.();
        }
        if (this.cancelled) return null;

        let steady = comfortable;
        if (comfortable) presentFps = Number(await request("get-present", "presentFps")) || 0;
        for (let attempt = 0; attempt < 2 && !steady; attempt++){
            panel.progress("Measuring your current settings", 0.15 + attempt * 0.1);
            const firstBase = attempt === 0 ? base : await measure();
            presentFps = Number(await request("get-present", "presentFps")) || 0;
            if (this.cancelled) return null;

            panel.progress("Checking the graphics card", 0.3 + attempt * 0.1);
            game.write(game.RESOLUTION, String(Math.max(0.1, resolution * 0.5)));
            await sleep(SETTLE_MS);
            lowRes = await measure();
            game.write(game.RESOLUTION, String(resolution));
            await sleep(SETTLE_MS);
            if (this.cancelled) return null;

            const secondBase = await measure();
            base = secondBase.fps > firstBase.fps ? secondBase : firstBase;
            // half the pixels cannot be slower either, a sample like that caught a hiccup
            steady =
                Math.abs(firstBase.fps - secondBase.fps) / Math.max(1, base.fps) <= STEADY_SPREAD &&
                lowRes.fps >= base.fps * (1 - STEADY_SPREAD);
        }
        // nothing may be concluded from a probe when the baseline itself does not hold
        if (!steady) lowRes = base;
        if (this.cancelled) return null;

        let highRes = null;
        if (steady && !comfortable && lowRes.fps / Math.max(1, base.fps) < 1.15 && resolution * 2 <= 2){
            panel.progress("Checking the graphics card", 0.55);
            game.write(game.RESOLUTION, String(resolution * 2));
            await sleep(SETTLE_MS);
            highRes = await measure();
        }
        game.write(game.RESOLUTION, String(resolution));
        if (this.cancelled) return null;

        const plan = decide(
            { baseFps: base.fps, lowResFps: dev.gpu ? base.fps * 1.5 : lowRes.fps, highResFps: highRes?.fps ?? null, p50: base.p50, p99: base.p99, presentFps },
            {
                hz,
                onBattery: dev.battery ?? Boolean(specs.onBattery),
                laptop,
                inMatch: venue.inMatch,
                readGameSetting: (id) => state.snapshot.game[id],
                throttle: Number(state.snapshot.client.throttle) || 1,
                gameFpsLimit: fpsLimitBefore,
                gameFrameCap: frameCapBefore,
            },
        );

        panel.progress("Applying", 0.65);
        /** @type {string[]} */
        const details = [];
        let needsReload = false;
        let limitChanged = false;
        for (const change of plan.changes){
            if (change.scope === "game"){
                details.push(`<b>${change.label}</b>: ${readable(state.snapshot.game[change.id])} → ${readable(change.value)}`);
                game.write(change.id, String(change.value));
                if (change.needsReload) needsReload = true;
            }
            else {
                details.push(`<b>${change.label}</b>: ${readable(state.snapshot.client[change.id])} → ${readable(change.value)}`);
                applyClient(change.id, change.value);
                if (change.id === "gameFpsLimit") limitChanged = true;
            }
        }

        // the resolution scale is the one thing the menu shows truthfully, so it is tuned by measuring.
        // only when the GPU is the limit and the cheaper settings did not get there
        if (plan.tuneResolution){
            await sleep(SETTLE_MS);
            let { fps } = await measure();
            let scale = resolution;
            // GPU bound frame rate goes with the pixel count, so one estimate lands close. a second step
            // only goes to the floor when the estimate was not enough
            for (let step = 0; step < 2 && fps < plan.target && scale > MIN_RESOLUTION && !this.cancelled; step++){
                const estimate = step === 0 ? scale * Math.sqrt(fps / plan.target) : MIN_RESOLUTION;
                scale = Math.min(scale, Math.max(MIN_RESOLUTION, Math.floor(estimate * 20) / 20));
                panel.progress(`Trying resolution ${scale}`, 0.75 + step * 0.1);
                game.write(game.RESOLUTION, String(scale));
                await sleep(SETTLE_MS);
                ({ fps } = await measure());
            }
            if (scale !== resolution) details.push(`<b>Resolution</b>: ${resolution} → ${scale}`);
        }
        if (this.cancelled) return null;

        if (!limitChanged && fpsLimitBefore > 0) applyClient("gameFpsLimit", fpsLimitBefore);
        game.resetCache();

        const limited = plan.regime === "gpu" ? "graphics card" : "processor";
        details.push(
            `${Math.round(base.fps)} FPS in ${venue.inMatch ? "a test match" : "the menu"}` +
                `${Math.round(plan.expectedFps) === Math.round(base.fps) ? "" : `, about ${Math.round(plan.expectedFps)} expected in long matches`}` +
                `, goal ${plan.target} (${hz} Hz)${comfortable ? ", well above it" : `, limited by the ${limited}`}` +
                `${plan.gpuHeadroom ? ", graphics card far from its limit" : ""}${plan.healthy ? "" : ", frames were piling up"}` +
                `${steady ? "" : ". The scene was too busy to test the graphics card"}`,
        );
        const changed = details.length > 1;
        return {
            needsReload,
            summary: {
                title: changed ? "Optimized" : "Already optimal",
                line: changed
                    ? `${details.length - 1} setting${details.length === 2 ? "" : "s"} changed for ${gpuName} at ${hz} Hz.`
                    : `Nothing to change for ${gpuName} at ${hz} Hz.`,
                details,
                changed,
            },
        };
    }

    /**
     * Start of the page: finish or clean up what a previous page left, and run on the first start.
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
            new Panel().result(state.summary, () => this.undo());
            return;
        }
        // no state at all: first start, or the storage was cleared
        // (the delay lets the freshly loaded menu finish streaming its assets in)
        if (!state) setTimeout(() => this.start(true), 6000);
    }
}

const autoDetect = new AutoDetect();
kute.autoDetect = autoDetect;
autoDetect.resume();
