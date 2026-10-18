import api from "../api.js";
import marketApi from "./api.js";
import { contributedSale, contributedTrade } from "./contributionData.js";

const KEY = "kute_market_contribution_checks";
const HOUR = 3_600_000;
const GAPI = "https://gapi.svc.krunker.io";

class Contributions {
    constructor(){
        this.running = false;
        this.busy = false;
        this.generation = 0;
        this.nextPostAt = 0;
        /** @type {number|undefined} */
        this.timer = undefined;
        /** @type {AbortController|null} */
        this.controller = null;
    }

    start(){
        if (this.running) return;
        this.running = true;
        this.timer = window.setTimeout(() => this.tick(), 45_000);
    }

    stop(){
        this.running = false;
        this.generation++;
        clearTimeout(this.timer);
        this.controller?.abort();
        this.controller = null;
    }

    active(){
        return this.running && !document.hidden && !document.pointerLockElement && !api.down && !api.offline() && Date.now() >= marketApi.retryAt && marketApi.loggedIn();
    }

    token(){
        const stored = localStorage.getItem("__FRVR_auth_access_token");
        if (!stored) return null;
        try { const parsed = JSON.parse(stored); return typeof parsed === "string" ? parsed : null; }
        catch { return stored; }
    }

    /** @param {AbortSignal} signal */
    async waitToPost(signal){
        const wait = Math.max(0, this.nextPostAt - Date.now());
        if (!wait || signal.aborted) return;
        await new Promise(resolve => {
            let timer = 0;
            const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(undefined); };
            timer = window.setTimeout(finish, wait);
            signal.addEventListener("abort", finish, { once: true });
        });
    }

    /** @param {string} path @param {string} token @param {AbortSignal} signal */
    async read(path, token, signal){
        const response = await fetch(GAPI + path, {
            headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error("history unavailable");
        const body = await response.json();
        if (body?.error || !body?.data) throw new Error("history unavailable");
        return body.data;
    }

    /** @param {"sales"|"trades"} kind @param {string} token @param {AbortSignal} signal */
    async collect(kind, token, signal){
        const rows = []; const now = Date.now();
        let cursor = ""; let offset = 0;
        for (let page = 0; page < 3; page++){
            if (!this.active() || token !== this.token() || signal.aborted) throw new Error("collection paused");
            const path = kind === "sales"
                ? `/market/history?sort=date_desc&limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`
                : `/trades/history?offset=${offset}&limit=100&include_open=0`;
            const data = await this.read(path, token, signal);
            const raw = kind === "sales" ? data.history : data.completed;
            if (!Array.isArray(raw)) throw new Error("unknown history format");
            rows.push(...raw.map(r => kind === "sales" ? contributedSale(r, now) : contributedTrade(r, now)).filter(Boolean));
            const more = kind === "sales" ? data.has_more : data.completed_has_more;
            if (!more || !raw.length || Date.parse(raw.at(-1)?.dte ?? raw.at(-1)?.date) < now - 48 * HOUR) break;
            cursor = String(data.next_cursor ?? "");
            offset += raw.length;
            if (kind === "sales" && !cursor) throw new Error("missing history cursor");
        }
        return rows;
    }

    async tick(){
        if (this.running) this.timer = window.setTimeout(() => this.tick(), 60_000);
        if (this.busy || !this.active() || Date.now() < marketApi.retryAt) return;
        const token = this.token();
        if (!token) return;
        this.busy = true;
        const {generation} = this;
        const controller = new AbortController();
        this.controller = controller;
        try {
            /** @type {Record<string,number>} */
            let checked = {};
            try { checked = JSON.parse(localStorage.getItem(KEY) ?? "{}"); }
            catch { /* rereading is safe because the server deduplicates transaction ids */ }
            for (const kind of /** @type {const} */ (["sales", "trades"])){
                if (Date.now() - (checked?.[kind] ?? 0) < HOUR) continue;
                try {
                    const rows = await this.collect(kind, token, controller.signal);
                    for (let start = 0; start < rows.length; start += 100){
                        await this.waitToPost(controller.signal);
                        if (!this.active() || generation !== this.generation || token !== this.token()) throw new Error("collection paused");
                        this.nextPostAt = Date.now() + 10_000;
                        const result = await marketApi.observe({ [kind]: rows.slice(start, start + 100) }, controller.signal);
                        if (!result) throw new Error("contribution unavailable");
                    }
                    if (!this.active() || generation !== this.generation || token !== this.token()) return;
                    checked = { ...checked, [kind]: Date.now() };
                    localStorage.setItem(KEY, JSON.stringify(checked));
                }
                catch { /* leave this source due; the other history can still succeed */ }
            }
        }
        finally {
            if (this.controller === controller) this.controller = null;
            this.busy = false;
        }
    }
}

const contrib = new Contributions();
export default contrib;
