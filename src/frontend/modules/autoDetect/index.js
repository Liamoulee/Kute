import panelHtml from "../../components/autoDetect.html";
import { kute } from "../../client.js";
import { hostLobby, inRoom, spawn } from "../privateMatch.js";
import { checkCompMode, request } from "../../utils.js";
import { cancel as cancelBench, currentPipeline, measureCaps, PIPELINE, searchPipeline } from "./clientBench.js";
import { decide, MIN_RESOLUTION, SIGNIFICANT_SETTING } from "./decide.js";
import { capCandidates, choose, chooseCap, EXPERIENCE, headroom, refineCaps, relative, summarize, TARGET_REFRESH_MULTIPLE } from "./policy.js";
import { REPLAY_CIRCLE_MS, takeInputDiagnostics, takeReading } from "./sample.js";
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
// whole camera circles of the input replay, so every reading ends where it started
const READ_MS = 3 * REPLAY_CIRCLE_MS;
const SETTING_READ_MS = 2 * REPLAY_CIRCLE_MS;
const SETTLE_MS = 450;
// a new fps limit needs a moment before the loop runs at it
const CAP_SETTLE_MS = 700;
// max spread between the samples around a measurement before we drop it
const STEADY_SPREAD = 0.08;
// everything the run may change in the client, for undo and rollback
const CLIENT_KEYS = ["gameFpsLimit", "throttle", ...PIPELINE.map((entry) => entry.setting)];
// input replay, bench run ids and the patch switches all live in the exe
const HOST_FEATURE = "autodetect-v2";
const HOME = "https://krunker.io/";
/** an experience metric that got worse, in the player's words @type {Record<string, string>} */
const WORSE = {
    taskP99: "the game reacted later",
    inputP99: "the mouse waited longer",
    p99: "slow frames came later",
    stallMs: "more stutter",
    maxMs: "a longer freeze",
};

/**
 * @typedef {import("./decide.js").MeasuredSetting} MeasuredSetting
 * @typedef {import("./policy.js").Reading} Reading
 * @typedef {import("./policy.js").Summary} MetricSummary
 * @typedef {import("./policy.js").Metric} Metric
 * @typedef {import("./clientBench.js").Pipeline} Pipeline
 * @typedef {import("./clientBench.js").PipelineRow} PipelineRow
 */

/**
 * @typedef {object} CapRow one fps limit the run measured
 * @property {number} cap 0 = no limit
 * @property {"client test"|"test match"} where
 * @property {MetricSummary} summary of the readings relative to the limit's own frame time, see policy.js relative
 * @property {number|null} frameMs typical frame time at this limit
 * @property {number|null} netMs delay it removes minus frame time it adds against the limit in use, null: not judged
 * @property {string} outcome "yours", "chosen", "better", "not better" or "worse"
 */

/**
 * @typedef {object} Report what the run measured, for the advanced view
 * @property {2} version
 * @property {string} gpu
 * @property {string} cpu
 * @property {number} hz
 * @property {boolean} laptop
 * @property {boolean|null} hybrid two graphics chips, frames get copied between them. null: could not tell
 * @property {string|null} powerOverlay windows power mode during the run
 * @property {number} capacity fps without a limit in the test match
 * @property {number} noise spread of the unlimited samples as a share
 * @property {number} drift last unlimited sample / first, below 1 when the PC got slower (heat)
 * @property {number} headroom margin over the target this PC needs, from its own drift and noise
 * @property {number} beforeCap the fps limit the player had, 0 = none
 * @property {MetricSummary} before measured as the player had it
 * @property {number} afterCap
 * @property {MetricSummary|null} after the final settings, null when nothing changed
 * @property {PipelineRow[]} pipeline client test rows, empty when the test did not run
 * @property {CapRow[]} caps
 * @property {number|null} halfResolutionGain
 * @property {MeasuredSetting[]} settings
 * @property {import("./decide.js").QualityPlan} plan
 * @property {import("./sample.js").InputDiagnostics} [input] whether the host's input script reached the game
 * @property {string|null} rolledBack why the run put the player's settings back, null when it did not
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
 * @typedef {object} Carry what the first half of a run hands across the restart in its middle
 * @property {Reading[]} asPlayed measured with the player's own fps limit, before anything changed
 * @property {Reading[]} uncapped the same without a limit
 * @property {number} playedCap
 * @property {Pipeline} pipelineBefore
 * @property {Pipeline} pipelineAfter
 * @property {boolean} pipelineChanged
 * @property {Metric|null} decidedBy
 * @property {PipelineRow[]} rows
 * @property {CapRow[]} benchCaps
 * @property {number[]} capOrder caps worth trying in the match, best in the client test first
 * @property {number} elapsedMs
 * @property {boolean} [resumed] the run already continued once after its restart, a second time would be a loop
 */

/**
 * @typedef {object} RunState
 * @property {"running"|"done"|"prompted"} status
 * @property {number} at
 * @property {{client: Record<string, any>, game: Record<string, string|null>}} snapshot what undo and cancel restore
 *     (from before the preset when the setup started the run)
 * @property {{client: Record<string, any>, game: Record<string, string|null>}} [baseline] while running: what was
 *     active at run start, after the preset. the run measures against and reverts to this
 * @property {Carry} [carry] set while the client restarts in the middle of a run
 * @property {string[]} [details] what the setup changed before the run, kept across the restart
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
        if (!input) continue;
        if (input.type === "checkbox") input.checked = value === true;
        else input.value = String(value);
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
 * @return {{hz?: number, battery?: boolean, laptop?: boolean, force?: string}}
 */
function devOverrides(){
    const match = /--autodetect-dev=(\S+)/.exec(kute.launchArgs ?? "");
    /** @type {{hz?: number, battery?: boolean, laptop?: boolean, force?: string}} */
    const overrides = {};
    for (const part of match?.[1].split(",") ?? []){
        const [key, value] = part.split(":");
        if (key === "hz") overrides.hz = Number(value);
        if (key === "battery") overrides.battery = true;
        if (key === "laptop") overrides.laptop = true;
        // "force:patchHighQoS": that flip wins the client test whatever it measured, to walk through the restart
        if (key === "force") overrides.force = value;
    }
    return overrides;
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
 * @param {number|null} value
 * @param {number} [digits]
 * @return {string}
 */
function shown(value, digits = 1){
    return value === null ? "?" : value.toFixed(digits);
}

/**
 * @param {number} cap
 * @return {string}
 */
function capName(cap){
    return cap > 0 ? `${cap} FPS` : "no limit";
}

/**
 * what a change bought, in the metric that decided it
 *
 * @param {Metric|null} metric
 * @param {MetricSummary} before
 * @param {MetricSummary} after
 * @return {string}
 */
function because(metric, before, after){
    if (metric === null) return "measured as smooth, with fewer frames to draw";
    const change = `${shown(before[metric].median)} to ${shown(after[metric].median)}`;
    return {
        taskP99: `the game reacts sooner: other work waited up to ${change} ms`,
        inputP99: `mouse input waits ${change} ms`,
        p99: `slowest frames ${change} ms`,
        stallMs: `stutter ${change} ms per second`,
        maxMs: `longest frame ${change} ms`,
        fps: `${shown(before.fps.median, 0)} to ${shown(after.fps.median, 0)} FPS`,
    }[metric];
}

/**
 * @param {number|null} value
 * @param {string} [sign] "+" for a value that counts from something else
 * @return {string} "1.4 ms", a dash when it was not measured
 */
function msText(value, sign = ""){
    return value === null ? "-" : `${sign}${value.toFixed(1)} ms`;
}

/**
 * @param {MetricSummary} summary
 * @return {string} table cells: fps, slowest frames, task delay, mouse wait
 */
function metricCells(summary){
    return `<td>${shown(summary.fps.median, 0)}</td><td>${msText(summary.p99.median)}</td><td>${msText(summary.taskP99.median)}</td><td>${msText(summary.inputP99.median)}</td>`;
}


/**
 * @param {import("./sample.js").InputDiagnostics|undefined} input
 * @return {string} what became of the host's input script, for the advanced view
 */
function inputLine(input){
    if (!input || input.readings === 0) return "";
    if (input.withInput > 0){
        return `<p>Input test: ${input.withInput} of ${input.readings} readings in the match had mouse input from Kute (${input.hostSteps} steps sent, ${input.pageEvents} seen by the game).</p>`;
    }
    // "stopped" is the next reading taking over a few ms early, not a failure
    const reasons = Object.entries(input.ended).filter(([reason]) => reason !== "done" && reason !== "stopped").map(([reason, count]) => `${reason}: ${count}x`).join(", ");
    let why = "the game did not hold the mouse when the readings started";
    if (input.asked > 0) why = reasons || `Kute sent ${input.hostSteps} steps, the game saw ${input.pageEvents} mouse events`;
    return `<p class="adChanged">The input test did not reach the game (${why}). Mouse wait and settings that only cost in a fight were not measured.</p>`;
}

/**
 * @param {Report} report
 * @return {string}
 */
function advancedHtml(report){
    const changed = new Set(report.plan.changes.map((change) => change.id));
    const settings = report.settings.map((setting) => {
        let measured = setting.note ?? "";
        if (setting.gain !== null) measured = setting.steady ? `${percent(setting.gain)} when ${readable(setting.cheap)}` : "unsteady, not used";
        const action = changed.has(setting.id) ? `<td class="adChanged">set to ${readable(setting.cheap)}</td>` : "<td>kept</td>";
        return `<tr><td>${setting.label}</td><td>${readable(setting.current)}</td><td>${measured}</td>${action}</tr>`;
    });
    const pipeline = report.pipeline.map((row) => {
        const summary = summarize(row.readings);
        return `<tr><td>${row.label}</td>${metricCells(summary)}<td${row.outcome === "better" ? ' class="adChanged"' : ""}>${row.outcome}</td></tr>`;
    });
    const caps = report.caps.map((row) => `<tr><td>${capName(row.cap)} (${row.where})</td><td>${msText(row.frameMs)}</td><td>${msText(row.summary.p99.median, "+")}</td>
        <td>${msText(row.summary.taskP99.median)}</td><td>${msText(row.summary.inputP99.median, "+")}</td><td>${row.netMs === null ? "" : msText(row.netMs, row.netMs > 0 ? "+" : "")}</td>
        <td${row.outcome === "chosen" ? ' class="adChanged"' : ""}>${row.outcome}</td></tr>`);
    const limited = { cpu: "the processor", gpu: "the graphics card", unknown: "not measured" }[report.plan.regime];
    const half = report.halfResolutionGain === null ? "not measured" : percent(report.halfResolutionGain);
    let graphics = "";
    if (report.hybrid === true) graphics = " Two graphics chips: frames get copied from one to the other.";
    else if (report.hybrid === null) graphics = " Could not tell which graphics chip drives the screen.";
    const header = "<th>FPS</th><th>Slowest 1 % of frames</th><th>Other work waits</th><th>Mouse waits</th><th>Result</th>";
    return `
        <p>${report.gpu}<br>${report.cpu}${report.laptop ? " (laptop)" : ""}, ${report.hz} Hz${report.powerOverlay ? `, Windows power mode: ${report.powerOverlay}` : ""}.${graphics}</p>
        <p>Without an FPS limit this PC ran ${Math.round(report.capacity)} FPS in the test match. Kute aims for at least ${report.plan.target} FPS
        (${TARGET_REFRESH_MULTIPLE}x your ${report.hz} Hz screen), and this PC needs ${Math.round(report.plan.needed)} to keep that in a fight:
        samples of the same settings differ by ${Math.round(report.noise * 100)} %, and it ended the run at ${Math.round(report.drift * 100)} % of its starting speed.</p>
        ${report.rolledBack ? `<p class="adChanged">${report.rolledBack}</p>` : ""}
        ${inputLine(report.input)}
        <table><tr><th>As you had it (${capName(report.beforeCap)})</th>${header}</tr><tr><td>before</td>${metricCells(report.before)}<td></td></tr>
        ${report.after ? `<tr><td>after (${capName(report.afterCap)})</td>${metricCells(report.after)}<td></td></tr>` : ""}</table>
        ${pipeline.length > 0 ? `<table><tr><th>Client test</th>${header}</tr>${pipeline.join("")}</table>` : "<p>The client test did not run, the client's own setup was left alone.</p>"}
        <table><tr><th>FPS limit</th><th>Frame time</th><th>Slowest 1 % beyond it</th><th>Other work waits</th><th>Mouse waits beyond it</th><th>Gain</th><th>Result</th></tr>${caps.join("")}</table>
        <p>A lower limit makes every frame longer. It is only taken when it removes more delay than that (gain above zero), and never when the game stalls more with it.</p>
        <p>Limited by ${limited} (half the resolution: ${half}).</p>
        <table><tr><th>Setting</th><th>Was</th><th>Measured</th><th>Result</th></tr>${settings.join("")}</table>
        <div class="adButton" id="adCopy" style="margin: 1em 0">Copy this report</div>
        <p>${report.seconds.toFixed(0)} s. A difference only counts when it is bigger than the spread between two samples of the same setup,
        and a setup that measures worse anywhere is never taken. Settings that need a reload cannot be measured in one test match, they were not changed.</p>`;
}

/**
 * every measured fps limit against the one in use, see chooseCap
 *
 * @param {Map<number, Reading[]>} readings per limit, 0 = none
 * @param {number} incumbentCap
 * @param {CapRow["where"]} where
 * @param {number} [prefer] the limit that takes over when it measures equal (laptops: the target rate)
 * @return {{rows: CapRow[], winner: number, reason: string, order: number[]}} order: limits worth another look, best first
 */
function rankCaps(readings, incumbentCap, where, prefer){
    const choice = chooseCap(readings, incumbentCap, { prefer });
    /** @type {CapRow[]} */
    const rows = choice.judged.map((entry) => ({ cap: entry.cap, where, summary: entry.summary, frameMs: entry.frameMs, netMs: entry.netMs, outcome: entry.outcome }));
    const won = choice.judged.find((entry) => entry.cap === choice.winner);
    let reason = "measures as smooth as before, with fewer frames to draw";
    if (choice.decidedBy === "net") reason = `${shown(won?.netMs ?? null)} ms less between what happens in the game and what you see`;
    const order = choice.judged
        .filter((entry) => entry.cap !== incumbentCap && entry.outcome !== "worse")
        .sort((a, b) => (b.netMs ?? -Infinity) - (a.netMs ?? -Infinity))
        .map((entry) => entry.cap);
    return { rows, winner: choice.winner, reason, order };
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

/**
 * @return {boolean} a restart-only setting differs from what this process was started with
 */
function restartNeeded(){
    return PIPELINE.some((entry) => (kute.settings.data[entry.setting] !== false) !== (kute.running?.[entry.setting] !== false));
}

/**
 * @param {RunState} state
 * @return {Report|undefined} a report stored by an older run has another shape, the summary shows without it
 */
function shownReport(state){
    return state.report?.version === 2 ? state.report : undefined;
}

/**
 * @param {Reading[]} readings
 * @return {number} median fps, 0 when none is usable
 */
function fpsOf(readings){
    return summarize(readings).fps.median ?? 0;
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
        // some restored values only apply after a reload (preset stuff) or restart (the client's own setup)
        const reloadIds = new Set(game.SETTINGS.filter((setting) => setting.needsReload).map((setting) => setting.id));
        const needsReload = Object.entries(state.snapshot.game).some(([id, value]) => reloadIds.has(id) && value !== null && game.read(id) !== value);
        this.restore(state.snapshot);
        const needsRestart = restartNeeded();
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
        new Panel().result(state.summary, { onUndo: state.undoable ? () => this.undo() : undefined, report: shownReport(state) });
    }

    /**
     * @param {{snapshot?: RunState["snapshot"], details?: string[], resume?: RunState}} [options] what the setup already
     *     changed and its pre-setup snapshot, or the stored run to continue after its restart
     * @return {Promise<void>}
     */
    async start(options = {}){
        if (this.running) return;
        if (!kute.hostFeatures?.includes(HOST_FEATURE)){
            kute.showNotification("Auto-detect needs a newer Kute, update the client to use it", false, 6);
            return;
        }
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

        /** @type {RunState} */
        let state;
        /** @type {RunState|null} */
        let previous;
        if (options.resume){
            state = options.resume;
            previous = state.previous ?? null;
        }
        else {
            previous = readState();
            // setup ends here, otherwise a cancel would restore its step and rerun on next load
            if (previous){
                delete previous.wizard;
                delete previous.wizardDetails;
            }
            // undo goes to pre-preset, measurements start from post-preset. don't mix them
            const baseline = this.snapshot();
            state = { status: "running", at: Date.now(), snapshot: options.snapshot ?? baseline, baseline, previous, details: options.details ?? [] };
            writeState(state);
        }

        const panel = new Panel();
        /**
         * @param {KeyboardEvent} event
         */
        const onKey = (event) => {
            if (event.key !== "Escape") return;
            this.cancelled = true;
            cancelBench();
        };
        document.addEventListener("keydown", onKey, true);

        const venue = { inMatch: false };
        const abandon = () => {
            window.chrome.webview.postMessage("input-replay-stop");
            this.restore(state.snapshot);
            if (previous) writeState(previous);
            else writeState({ status: "prompted", at: Date.now(), snapshot: state.snapshot });
            panel.close();
            // stopped after the restart in its middle: the client still runs the setup it was testing
            if (restartNeeded()) kute.showNotification("Your settings are back. Restart Kute to finish", false, 7);
            if (venue.inMatch){
                document.exitPointerLock();
                location.href = HOME;
            }
        };

        try {
            const outcome = await this.run(panel, state, venue);
            // the client restarts and resume() continues the stored run
            if (outcome === "restarting") return;
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
            delete state.carry;
            delete state.details;
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
     * what the client itself could do better (bench processes, from the menu), then in one private match: how the game
     * runs as the player has it, which fps limit runs best, game settings only while the PC misses its target, and a
     * last check of the result against the start. a client setup that changes needs a restart in the middle
     *
     * @param {Panel} panel
     * @param {RunState} state
     * @param {{inMatch: boolean}} venue
     * @return {Promise<{summary: Summary, report: Report}|"restarting"|null>} null when cancelled
     */
    async run(panel, state, venue){
        const dev = devOverrides();
        const baseline = state.baseline ?? state.snapshot;
        const earlier = state.details ?? [];
        const started = performance.now() - (state.carry?.elapsedMs ?? 0);
        // the second half of a run, after the restart in its middle
        const resumed = Boolean(state.carry);

        panel.progress("Reading your hardware", 0.02);
        const specs = await request("get-specs", "specs");
        if (specs === null) throw new Error("this needs a newer version of the client");
        /** @type {{hz: number, hostsWindow: boolean}[]} */
        const displays = specs.displays ?? [];
        const display = displays.find((entry) => entry.hostsWindow) ?? displays[0];
        const hz = dev.hz ?? (display?.hz > 1 ? display.hz : 60);
        /** @type {{name: string, software: boolean, vramMb: number}[]} */
        const gpus = (specs.gpus ?? []).filter((/** @type {{software: boolean}} */ gpu) => !gpu.software);
        // the adapter the game renders on when the exe knows it, else the one with the most memory
        const gpuName = specs.renderAdapter?.name ?? [...gpus].sort((a, b) => b.vramMb - a.vramMb)[0]?.name ?? "unknown graphics card";
        const onBattery = dev.battery ?? Boolean(specs.onBattery);
        // heat and a shared power budget: a laptop that measures the same at its target rate does not draw more
        const mobile = dev.laptop ?? (Boolean(specs.laptop) || specs.hybrid === true);
        const target = hz * TARGET_REFRESH_MULTIPLE;

        const frameCapBefore = Number(baseline.game[game.GAME_FRAME_CAP]) || 0;
        const fpsLimitBefore = Number(baseline.client.gameFpsLimit) || 0;
        // krunker's frame cap spins inside the loop, ours idles: the player's rate gets measured through ours
        const playedCap = fpsLimitBefore || frameCapBefore;

        // the client's own setup first, from the menu: bench processes while this page is hidden
        const pipelineBefore = currentPipeline();
        /** @type {import("./clientBench.js").PipelineSearch|null} */
        let search = null;
        /** @type {CapRow[]} */
        let benchCaps = [];
        /** @type {number[]} */
        let capOrder = [];
        if (!resumed){
            search = await searchPipeline({ hz, hybrid: specs.hybrid === true, progress: (text, share) => panel.progress(text, 0.03 + 0.27 * share), cancelled: () => this.cancelled });
            if (this.cancelled) return null;
            if (search && dev.force && dev.force in pipelineBefore){
                search = { ...search, winner: { ...pipelineBefore, [dev.force]: !pipelineBefore[dev.force] }, changed: true, decidedBy: "p99" };
            }
            if (search){
                panel.progress("Testing FPS limits", 0.31);
                const benchList = [...new Set([0, target, 2 * hz, hz, playedCap])].sort((a, b) => b - a);
                const measured = await measureCaps({ pipeline: search.winner, common: search.common, caps: benchList, cancelled: () => this.cancelled });
                if (this.cancelled) return null;
                if (measured){
                    const ranked = rankCaps(measured, playedCap, "client test", mobile ? target : undefined);
                    benchCaps = ranked.rows;
                    capOrder = ranked.order;
                }
            }
        }

        panel.progress("Opening a private test match", 0.38);
        panel.clickThrough(true);
        const room = await hostLobby();
        let joined = false;
        if (room){
            panel.progress("Joining the test match", 0.41);
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

        if (frameCapBefore > 0) game.write(game.GAME_FRAME_CAP, "0");
        let appliedCap = Number(kute.settings.data.gameFpsLimit) || 0;
        takeInputDiagnostics();
        window.chrome.webview.postMessage("throttle, off");
        // assets and shaders still loading
        await sleep(2500);
        // again, pointer lock posts the in-game throttle and can race the first "off"
        window.chrome.webview.postMessage("throttle, off");
        await sleep(300);
        window.chrome.webview.postMessage("bring-to-front");

        /**
         * one reading at an fps limit, the host turns the camera and fires meanwhile
         *
         * @param {number} cap 0 = no limit
         * @param {number} [ms]
         * @return {Promise<Reading>}
         */
        const sample = async(cap, ms = READ_MS) => {
            if (cap !== appliedCap){
                applyClient("gameFpsLimit", cap);
                appliedCap = cap;
                await sleep(CAP_SETTLE_MS);
            }
            stillInRoom();
            return takeReading({ ms, hz, replay: true });
        };
        /**
         * two readings per limit, interleaved (A B C A B C) so drift hits all of them alike
         *
         * @param {number[]} caps
         * @return {Promise<Map<number, Reading[]>>}
         */
        const sampleEach = async(caps) => {
            /** @type {Map<number, Reading[]>} */
            const readings = new Map(caps.map((cap) => [cap, []]));
            for (let round = 0; round < 2; round++){
                for (const cap of caps){
                    if (this.cancelled) return readings;
                    readings.get(cap)?.push(await sample(cap));
                }
            }
            return readings;
        };

        let { carry } = state;
        if (!carry){
            panel.progress("Measuring how the game runs now", 0.45);
            // thrown away: the first seconds after a spawn still load and hitch (stall 9 +- 18 ms per second measured)
            await sample(playedCap);
            const asPlayed = [await sample(playedCap), await sample(playedCap)];
            panel.progress("Measuring what this PC can do", 0.5);
            const uncapped = playedCap === 0 ? [...asPlayed, await sample(0)] : [await sample(0), await sample(0), await sample(0)];
            if (this.cancelled) return null;
            carry = {
                asPlayed,
                uncapped,
                playedCap,
                pipelineBefore,
                pipelineAfter: search?.winner ?? pipelineBefore,
                pipelineChanged: Boolean(search?.changed),
                decidedBy: search?.decidedBy ?? null,
                rows: search?.rows ?? [],
                benchCaps,
                capOrder,
                elapsedMs: performance.now() - started,
            };
            if (carry.pipelineChanged){
                state.carry = carry;
                writeState(state);
                // back to how the player had it, the second half sets its own limits again
                if (frameCapBefore > 0) game.write(game.GAME_FRAME_CAP, String(frameCapBefore));
                if (appliedCap !== fpsLimitBefore) applyClient("gameFpsLimit", fpsLimitBefore);
                for (const entry of PIPELINE){
                    if (carry.pipelineAfter[entry.setting] !== pipelineBefore[entry.setting]) applyClient(entry.setting, carry.pipelineAfter[entry.setting]);
                }
                document.exitPointerLock();
                panel.choose("Kute restarts once", "The client test found a setup that runs better on this PC. Kute restarts with it and checks it in the game, the test goes on by itself.", []);
                await sleep(3500);
                window.chrome.webview.postMessage("restart");
                return "restarting";
            }
        }
        const { playedCap: originalCap } = carry;
        const run = carry;

        /**
         * @param {Partial<Report>} fields
         * @return {Report}
         */
        const report = (fields) => ({
            version: 2,
            gpu: gpuName,
            cpu: `${specs.cpu?.name ?? "unknown processor"}, ${specs.cpu?.threads ?? "?"} threads`,
            hz,
            laptop: Boolean(specs.laptop),
            hybrid: typeof specs.hybrid === "boolean" ? specs.hybrid : null,
            powerOverlay: specs.powerOverlay ?? null,
            capacity: fpsOf(run.uncapped),
            noise: 0,
            drift: 1,
            headroom: 1,
            beforeCap: originalCap,
            before: summarize(run.asPlayed),
            afterCap: originalCap,
            after: null,
            pipeline: run.rows,
            caps: run.benchCaps,
            halfResolutionGain: null,
            settings: [],
            plan: decide({ capacity: fpsOf(run.uncapped), hz, headroom: 1, halfResolutionGain: null, settings: [] }),
            input: takeInputDiagnostics(),
            rolledBack: null,
            seconds: (performance.now() - started) / 1000,
            ...fields,
        });
        /**
         * @param {string} why
         * @param {Partial<Report>} [measured] what the run had measured by then, the advanced view explains the rollback with it
         * @return {{summary: Summary, report: Report}} the player's settings are back
         */
        const rollBack = (why, measured = {}) => {
            this.restore(state.snapshot);
            const needsRestart = restartNeeded();
            return {
                summary: { title: "Nothing changed", line: needsRestart ? `${why} Restart Kute to finish.` : why, details: [], changed: false, needsRestart },
                report: report({ ...measured, rolledBack: why }),
            };
        };
        /**
         * is `after` worse than `before` in how the game feels? relative metrics: the two may come from different
         * spawns or fps limits, where frame times are not comparable but lateness beyond the frame time is
         *
         * @param {Reading[]} first
         * @param {Reading[]} after
         * @return {string|null} what got worse, in the player's words. null: nothing did
         */
        const feelsWorse = (first, after) => {
            const { verdicts } = choose({ id: "before", readings: first.map(relative) }, [{ id: "after", readings: after.map(relative) }], { fpsCounts: false }).judged[0];
            const metric = EXPERIENCE.find((entry) => verdicts[entry] === "worse");
            return metric ? WORSE[metric] : null;
        };

        /** @type {string[]} */
        const details = [...earlier];
        if (resumed && run.pipelineChanged){
            panel.progress("Checking the new setup in the game", 0.5);
            const uncappedNow = [await sample(0), await sample(0)];
            if (this.cancelled) return null;
            // faster on the test scene is a hint, the game decides: it must not run worse here
            const worse = feelsWorse(run.uncapped, uncappedNow);
            if (worse) return rollBack(`The setup that won the client test ran worse in the game (${worse}), so Kute put yours back.`);
            const winnerRow = run.rows.find((row) => PIPELINE.every((entry) => row.pipeline[entry.setting] === run.pipelineAfter[entry.setting]));
            const reason = winnerRow ? because(run.decidedBy, summarize(run.rows[0].readings), summarize(winnerRow.readings)) : "measured better";
            for (const entry of PIPELINE){
                if (run.pipelineAfter[entry.setting] === run.pipelineBefore[entry.setting]) continue;
                details.push(`<b>${entry.label}</b>: ${readable(run.pipelineBefore[entry.setting])} → ${readable(run.pipelineAfter[entry.setting])} (${reason})`);
            }
        }

        panel.progress("Finding the FPS limit that runs best", 0.56);
        const roughCapacity = fpsOf(run.uncapped);
        // on battery, frames beyond the target only drain it
        const batteryCap = roughCapacity >= target ? target : hz;
        const allowed = (/** @type {number} */ cap) => !onBattery || cap === originalCap || (cap !== 0 && cap <= target);
        // a laptop that measures the same at its target rate takes it over everything the PC can do
        const prefer = mobile && roughCapacity >= target ? target : undefined;
        const fromBench = run.capOrder.length > 0 ? run.capOrder.slice(0, 2) : capCandidates({ hz, capacity: roughCapacity, current: originalCap }).slice(1, 3);
        const candidates = [...new Set([originalCap, 0, ...fromBench, ...(prefer ? [prefer] : []), ...(onBattery ? [batteryCap] : [])])].filter(allowed);
        const measuredCaps = await sampleEach(candidates);
        if (this.cancelled) return null;
        const ranked = rankCaps(measuredCaps, originalCap, "test match", prefer);
        const { rows: capRows } = ranked;
        let bestCap = ranked.winner;
        let capReason = ranked.reason;
        // what the pc does without a limit, on this spawn
        const capacity = fpsOf(measuredCaps.get(0) ?? []) || roughCapacity;

        // one more look between the best limit and its neighbours
        const between = refineCaps([...measuredCaps.keys()], bestCap, capacity).filter((cap) => allowed(cap) && cap < capacity);
        if (between.length > 0){
            panel.progress("Fine tuning the FPS limit", 0.64);
            const finer = await sampleEach(between);
            if (this.cancelled) return null;
            const refined = rankCaps(new Map([[bestCap, measuredCaps.get(bestCap) ?? []], ...finer]), bestCap, "test match");
            capRows.push(...refined.rows.filter((row) => row.cap !== bestCap));
            for (const [cap, readings] of finer) measuredCaps.set(cap, readings);
            if (refined.winner !== bestCap){
                bestCap = refined.winner;
                capReason = refined.reason;
            }
        }
        if (onBattery && (bestCap === 0 || bestCap > target) && capRows.find((row) => row.cap === batteryCap)?.outcome !== "worse"){
            bestCap = batteryCap;
            capReason = "on battery";
        }
        for (const row of capRows){
            if (row.cap === bestCap && row.cap !== originalCap) row.outcome = "chosen";
        }

        // this PC's own margin: how much it slowed down during the match, and how much two samples of one setup differ
        const late = await sample(0);
        const firstUncapped = (resumed ? measuredCaps.get(0)?.[0] : run.uncapped[0])?.fps ?? capacity;
        const speeds = run.uncapped.map((reading) => reading.fps).filter((fps) => typeof fps === "number");
        const noise = speeds.length > 1 ? (Math.max(...speeds) - Math.min(...speeds)) / Math.max(1, ...speeds) : 0;
        const drift = (late.fps ?? capacity) / Math.max(1, firstUncapped);
        const margin = headroom(drift, noise);
        const needed = target * margin;

        /** @type {MeasuredSetting[]} */
        const settings = [];
        /** @type {number|null} */
        let halfResolutionGain = null;
        const resolution = Number(baseline.game[game.RESOLUTION]) || 1;
        if (capacity < needed){
            // the replay shoots, so what only costs in a fight is on screen. no pointer events: it did not reach the page
            const replayWorks = run.asPlayed.some((reading) => reading.inputP99 !== null);
            // compare against the mean of the samples before and after, cancels heat drift
            let reference = late.fps ?? capacity;
            /**
             * @param {() => void} apply
             * @param {() => void} revert
             * @return {Promise<{ratio: number, steady: boolean, raw: number[]}>}
             */
            const compare = async(apply, revert) => {
                const first = reference;
                apply();
                await sleep(SETTLE_MS);
                const changed = (await sample(0, SETTING_READ_MS)).fps ?? 0;
                revert();
                await sleep(SETTLE_MS);
                const after = (await sample(0, SETTING_READ_MS)).fps ?? 0;
                reference = after;
                const mean = (first + after) / 2;
                return {
                    ratio: changed / Math.max(1, mean),
                    steady: Math.abs(first - after) / Math.max(1, mean) <= STEADY_SPREAD,
                    raw: [first, changed, after],
                };
            };

            const live = game.SETTINGS.filter((setting) => !setting.needsReload && (replayWorks || !setting.fightOnly));
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
                if (setting.fightOnly && !replayWorks){
                    row.note = "not tested (only costs in a fight)";
                    continue;
                }
                if (current === null){
                    row.note = "value unknown";
                    continue;
                }
                if (this.cancelled) return null;
                panel.progress(`Measuring ${setting.label}`, 0.68 + (0.17 * live.indexOf(setting)) / live.length);
                const flipped = game.opposite(current);
                const { ratio, steady, raw } = await compare(() => game.write(setting.id, flipped), () => game.write(setting.id, current));
                // always stored as what the cheap value gains
                row.gain = flipped === cheap ? ratio : 1 / Math.max(0.01, ratio);
                row.steady = steady;
                row.raw = raw;
            }
            // settings we'd change get measured twice, the lower gain counts
            for (const row of settings){
                if (row.gain === null || !row.steady || row.current === row.cheap || row.gain < SIGNIFICANT_SETTING) continue;
                if (this.cancelled) return null;
                panel.progress(`Confirming ${row.label}`, 0.86);
                const { ratio, steady } = await compare(() => game.write(row.id, row.cheap), () => game.write(row.id, row.current));
                row.confirmGain = ratio;
                row.gain = Math.min(row.gain, ratio);
                row.steady = steady;
            }
            panel.progress("Checking the graphics card", 0.88);
            const half = await compare(
                () => game.write(game.RESOLUTION, String(Math.max(0.1, resolution * 0.5))),
                () => game.write(game.RESOLUTION, String(resolution)),
            );
            // fewer pixels can't be slower, a ratio well below 1 is a hiccup
            halfResolutionGain = half.steady && half.ratio > 0.92 ? half.ratio : null;
        }
        else {
            for (const setting of game.SETTINGS){
                settings.push({ id: setting.id, label: setting.label, current: baseline.game[setting.id] ?? "default", cheap: String(setting.cheap), gain: null, steady: true, note: "not tested (this PC reaches its target)" });
            }
        }
        if (this.cancelled) return null;

        const plan = decide({ capacity, hz, headroom: margin, halfResolutionGain, settings });
        for (const change of plan.changes){
            details.push(`<b>${change.label}</b>: ${readable(baseline.game[change.id])} → ${readable(change.value)} (${change.reason})`);
            game.write(change.id, String(change.value));
        }
        /** @type {number|null} */
        let capacityAfter = null;
        if (plan.changes.length > 0 || plan.tuneResolution){
            await sleep(SETTLE_MS);
            capacityAfter = (await sample(0, SETTING_READ_MS)).fps;
        }
        // gpu bound and still short: fps follows pixel count, estimate once then verify
        if (plan.tuneResolution && capacityAfter !== null){
            let scale = resolution;
            for (let step = 0; step < 2 && capacityAfter !== null && capacityAfter < plan.needed && scale > MIN_RESOLUTION && !this.cancelled; step++){
                const estimate = step === 0 ? scale * Math.sqrt(capacityAfter / plan.needed) : MIN_RESOLUTION;
                scale = Math.min(scale, Math.max(MIN_RESOLUTION, Math.floor(estimate * 20) / 20));
                panel.progress(`Trying resolution ${scale}`, 0.9 + step * 0.01);
                game.write(game.RESOLUTION, String(scale));
                await sleep(SETTLE_MS);
                capacityAfter = (await sample(0, SETTING_READ_MS)).fps;
            }
            if (scale !== resolution) details.push(`<b>Resolution</b>: ${resolution} → ${scale} (the graphics card is the limit)`);
        }
        if (this.cancelled) return null;

        // the whole result against how the player started. anything worse and everything goes back
        panel.progress("Checking the result", 0.94);
        // thrown away: changed game settings recompile shaders in their first seconds
        if (plan.changes.length > 0) await sample(bestCap);
        const finalReadings = [await sample(bestCap), await sample(bestCap)];
        if (this.cancelled) return null;
        const capChanged = bestCap !== originalCap;
        // same number, but held by kute's limiter with the processor idle instead of the game's busy loop
        const capMoved = !capChanged && frameCapBefore > 0 && fpsLimitBefore === 0;
        if (capChanged) details.push(`<b>FPS Limit</b>: ${capName(originalCap)} → ${capName(bestCap)} (${capReason})`);
        else if (capMoved) details.push(`<b>FPS Limit</b>: ${capName(bestCap)}, now held by Kute instead of the game's frame cap (the game's cap keeps the processor busy while it waits)`);
        const changed = details.length > 0;
        const ownChanges = details.length > earlier.length;
        if (ownChanges){
            // on this spawn when there was no restart, the readings from before it otherwise
            const reference = resumed ? run.asPlayed : measuredCaps.get(originalCap) ?? run.asPlayed;
            const worse = feelsWorse(reference, finalReadings);
            if (worse){
                return rollBack(`The new settings measured worse than yours in the last check (${worse}), so Kute put yours back.`, {
                    capacity,
                    noise,
                    drift,
                    headroom: margin,
                    afterCap: bestCap,
                    after: summarize(finalReadings),
                    caps: [...run.benchCaps, ...capRows],
                    halfResolutionGain,
                    settings,
                    plan,
                });
            }
        }
        else {
            // nothing of the run's own to keep: the game's frame cap and the limit as they were
            if (frameCapBefore > 0) game.write(game.GAME_FRAME_CAP, String(frameCapBefore));
            if (appliedCap !== fpsLimitBefore) applyClient("gameFpsLimit", fpsLimitBefore);
        }
        game.resetCache();

        const aims = `${target} FPS (${TARGET_REFRESH_MULTIPLE}x your ${hz} Hz screen)`;
        const count = `${details.length} setting${details.length === 1 ? "" : "s"} changed.`;
        let line = `Your PC ran ${Math.round(capacity)} FPS in the test match, above the ${aims} Kute aims for. Nothing needed changing.`;
        if (changed && capacityAfter !== null) line = `${count} Test match without a limit: ${Math.round(capacity)} FPS before, ${Math.round(capacityAfter)} after. Kute aims for at least ${aims} with no stutter.`;
        else if (changed) line = `${count} Without a limit your PC runs ${Math.round(capacity)} FPS in the test match, Kute aims for at least ${aims} with no stutter.`;
        else if (capacity < target) line = `Your PC ran ${Math.round(capacity)} FPS in the test match, Kute aims for at least ${aims}. No setting measurably helps on this PC, so nothing was changed.`;

        // the host says how its last input script ended a moment after the reading itself
        await sleep(150);
        const needsRestart = restartNeeded();
        return {
            summary: { title: changed ? "Optimized" : "Nothing to change", line: needsRestart ? `${line} Restart Kute to finish.` : line, details, changed, needsRestart },
            report: report({
                capacity,
                noise,
                drift,
                headroom: margin,
                afterCap: bestCap,
                after: ownChanges ? summarize(finalReadings) : null,
                caps: [...run.benchCaps, ...capRows],
                halfResolutionGain,
                settings,
                plan,
            }),
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
        // an exe older than the run's host side: no prompt for something it cannot do
        if (this.running || sessionStorage.getItem(ASKED_KEY) || !kute.hostFeatures?.includes(HOST_FEATURE)) return;
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

    // page start: clean up a previous page, continue a run or the setup, or offer on a first start
    resume(){
        const state = readState();
        if (state?.status === "running"){
            // the restart in the middle of a run: continue it, once
            if (state.carry && !state.carry.resumed){
                state.carry.resumed = true;
                writeState(state);
                setTimeout(async() => {
                    if (await this.signedIn()){
                        this.start({ resume: state });
                        return;
                    }
                    this.restore(state.snapshot);
                    if (state.previous) writeState(state.previous);
                    else localStorage.removeItem(STORAGE_KEY);
                    kute.showNotification("Auto-detect could not go on (not logged in). Your settings are back, restart Kute to finish", false, 8);
                }, RESUME_RUN_DELAY_MS);
                return;
            }
            // closed or crashed mid run
            this.restore(state.snapshot);
            if (state.previous) writeState(state.previous);
            else localStorage.removeItem(STORAGE_KEY);
            return;
        }
        if (state?.showSummary && state.summary){
            state.showSummary = false;
            writeState(state);
            new Panel().result(state.summary, { onUndo: () => this.undo(), report: shownReport(state) });
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
