import styles from "../components/nukeCounter.css";
import { kute } from "../client.js";

// career nuke total, ported from the Krunker Civilian Client (GPL-3.0)
// profile API only updates at match end, so refetch after the end screen instead of polling

/**
 * @typedef {object} NukeCounterConfig
 * @property {number} goal 0 hides it
 * @property {boolean} background
 */

/** @type {NukeCounterConfig} */
const DEFAULT_CONFIG = { goal: 0, background: true };

const PLAYER_API = "https://gapi.svc.krunker.io/players/";
// one timer for reattach, first fetch and end screen. never reads layout
const TICK_MS = 2000;
const RETRY_MS = 30000;
// stat commit usually lands a few seconds after the end screen, not always
const COMMIT_DELAYS = [5000, 20000];
const GAIN_MS = 8000;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @return {number}
 */
function clamp(value, min, max){
    return Math.min(max, Math.max(min, Number(value) || 0));
}

/**
 * @param {number} value
 * @return {string}
 */
function format(value){
    return value.toLocaleString("en-US");
}

class NukeCounter {
    constructor(){
        /** @type {HTMLElement|null} */
        this.overlay = null;
        /** @type {number|null} null while unknown */
        this.nukes = null;
        /** @type {string} owner of the total, account switch drops it */
        this.nukesFor = "";
        /** @type {boolean} profile has no nuke stat, don't retry */
        this.noStat = false;
        /** @type {boolean} */
        this.fetching = false;
        /** @type {number} */
        this.lastTry = 0;
        /** @type {boolean} */
        this.endWasUp = false;
        /** @type {number|null} */
        this.tick = null;
        /** @type {number[]} */
        this.commitTimers = [];

        kute.nukeCounter = { showOptions: () => this.showOptions() };
        kute.settings.toggleNukeCounter = (enabled) => this.toggle(enabled);

        this.toggle(!!kute.settings.data.nukeCounter);
    }

    /**
     * profile api key, empty while logged out
     *
     * @return {string}
     */
    accountName(){
        try {
            return window.localStorage.getItem("krunker_username") ?? "";
        }
        catch {
            return "";
        }
    }

    /**
     * @return {NukeCounterConfig}
     */
    get config(){
        return { ...DEFAULT_CONFIG, ...kute.settings.data.nukeCounterConfig };
    }

    /**
     * @param {NukeCounterConfig} config
     */
    saveConfig(config){
        kute.settings.data.nukeCounterConfig = config;
        window.chrome.webview.postMessage(`set-config-json nukeCounterConfig ${JSON.stringify(config)}`);
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        if (!enabled){
            this.destroy();
            return;
        }
        if (!document.querySelector("#kuteNukeCounterCSS")){
            const style = document.createElement("style");
            style.id = "kuteNukeCounterCSS";
            style.textContent = styles;
            document.head.append(style);
        }
        this.inject();
        if (this.nukes === null) this.refresh();
        this.tick ??= setInterval(() => this.onTick(), TICK_MS);
    }

    // total stays cached
    destroy(){
        if (this.tick !== null){
            clearInterval(this.tick);
            this.tick = null;
        }
        for (const timer of this.commitTimers) clearTimeout(timer);
        this.commitTimers = [];
        this.overlay?.remove();
        this.overlay = null;
        document.querySelector("#kuteNukeCounterCSS")?.remove();
        this.endWasUp = false;
    }

    inject(){
        if (!this.accountName()) return;
        if (this.overlay?.isConnected) return;

        this.overlay?.remove();
        const overlay = document.createElement("div");
        overlay.id = "kuteNukeCounter";
        overlay.innerHTML = '<span class="nukeIcon">☢</span><span class="nukeCount">—</span><span class="nukeGoal"></span>';
        (document.querySelector("#uiBase") ?? document.body).append(overlay);

        this.overlay = overlay;
        this.applyConfig();
        this.render();
    }

    /**
     * backdrop only, position and size come from the HUD layout
     */
    applyConfig(){
        this.overlay?.classList.toggle("nukeBg", this.config.background);
    }

    render(){
        const { overlay } = this;
        if (!overlay) return;
        const { goal } = this.config;
        const count = overlay.querySelector(".nukeCount");
        const goalElement = /** @type {HTMLElement|null} */ (overlay.querySelector(".nukeGoal"));
        if (count) count.textContent = this.nukes === null ? "—" : format(this.nukes);
        if (goalElement){
            goalElement.style.display = goal > 0 ? "" : "none";
            goalElement.textContent = `/ ${format(goal)}`;
        }
        overlay.classList.toggle("nukeGoalMet", goal > 0 && this.nukes !== null && this.nukes >= goal);
    }

    /**
     * @param {number} gain
     */
    showGain(gain){
        const { overlay } = this;
        if (!overlay || gain <= 0) return;
        overlay.querySelector(".nukeGain")?.remove();
        const element = document.createElement("span");
        element.className = "nukeGain";
        element.textContent = `+${format(gain)}`;
        overlay.append(element);
        setTimeout(() => element.remove(), GAIN_MS);
    }

    refresh(){
        const name = this.accountName();
        if (!name || this.fetching) return;
        this.fetching = true;
        this.lastTry = Date.now();

        window.fetch(PLAYER_API + encodeURIComponent(name), { credentials: "omit", signal: AbortSignal.timeout(10000) })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
                const total = body?.data?.player_stats?.n;
                if (typeof total === "number"){
                    const gain = this.nukes === null || this.nukesFor !== name ? 0 : total - this.nukes;
                    this.nukes = total;
                    this.noStat = false;
                    this.nukesFor = name;
                    this.render();
                    this.showGain(gain);
                }
                else if (body){
                    this.noStat = true;
                    this.nukesFor = name;
                }
            })
            .catch(() => {
                // offline or rate limited, tick retries after RETRY_MS
            })
            .finally(() => {
                this.fetching = false;
            });
    }

    onTick(){
        this.inject();
        const name = this.accountName();
        if (name !== this.nukesFor && (this.nukes !== null || this.noStat)){
            // logged out or switched account
            this.nukes = null;
            this.noStat = false;
            this.lastTry = 0;
            this.render();
        }
        if (this.nukes === null && !this.noStat && Date.now() - this.lastTry > RETRY_MS) this.refresh();

        const endUI = /** @type {HTMLElement|null} */ (document.querySelector("#endUI"));
        const endIsUp = !!endUI && endUI.style.display !== "none";
        if (endIsUp && !this.endWasUp && this.commitTimers.length === 0){
            this.commitTimers = COMMIT_DELAYS.map((delay, index) => setTimeout(() => {
                // last one frees the slot for the next end screen
                if (index === COMMIT_DELAYS.length - 1) this.commitTimers = [];
                this.refresh();
            }, delay));
        }
        this.endWasUp = endIsUp;
    }

    // position and size live in the HUD editor
    async showOptions(){
        const html = await import("../components/nukeCounterOptions.html");
        const { config } = this;

        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = html.default;

        /**
         * @param {string} id
         * @return {HTMLInputElement}
         */
        const element = (id) => /** @type {HTMLInputElement} */ (shadow.querySelector(`#${id}`));

        const apply = () => {
            kute.settings.data.nukeCounterConfig = config;
            this.applyConfig();
            this.render();
        };

        element("nkGoalInput").value = String(config.goal);
        element("nkBackground").checked = config.background;

        element("nkGoalInput").oninput = (event) => {
            const value = Number.parseInt(/** @type {HTMLInputElement} */ (event.target).value, 10);
            config.goal = Number.isNaN(value) ? 0 : clamp(value, 0, 1000000);
            apply();
        };
        element("nkBackground").onchange = (event) => {
            config.background = /** @type {HTMLInputElement} */ (event.target).checked;
            apply();
        };

        const controller = new AbortController();
        const close = () => {
            controller.abort();
            overlay.remove();
            this.saveConfig(config);
        };
        element("nkDone").onclick = close;
        element("nkPlace").onclick = () => {
            close();
            kute.hudEditor?.edit();
        };
        overlay.addEventListener("mousedown", (event) => {
            if (event.target === overlay) close();
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                close();
            },
            { signal: controller.signal, capture: true },
        );
        document.body.append(overlay);
    }
}

export default new NukeCounter();
