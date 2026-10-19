import { kute } from "../../client.js";
import api from "../api.js";
import marketApi from "./api.js";
import { contributedSale, contributedTrade } from "./contributionData.js";

// the host hands over the game's own completed history replies (modules/history.rs); nothing here
// touches fetch or another page global, krunker's cheat checks would see that

class Contributions {
    constructor(){
        this.running = false;
        this.generation = 0;
        this.nextPostAt = 0;
        this.failures = 0;
        this.account = "";
        /** @type {Map<string,{kind:"sales"|"trades",row:object}>} */
        this.queue = new Map();
        /** @type {Set<string>} */
        this.sent = new Set();
        /** @type {number|undefined} */
        this.timer = undefined;
        /** @type {AbortController|null} */
        this.controller = null;
        this.listener = (/** @type {MessageEvent} */ event) => this.receive(event);
    }

    start(){
        if (this.running || !kute.hostFeatures?.includes("history-capture")) return;
        this.running = true;
        this.generation++;
        window.chrome.webview.addEventListener("message", this.listener);
    }

    stop(){
        if (this.running) window.chrome.webview.removeEventListener("message", this.listener);
        this.running = false;
        this.generation++;
        clearTimeout(this.timer);
        this.controller?.abort();
        this.controller = null;
        this.queue.clear();
        this.sent.clear();
    }

    active(){
        return this.running && !document.hidden && !document.pointerLockElement && !api.down && !api.offline() && marketApi.loggedIn();
    }

    currentAccount(){
        try { return localStorage.getItem("krunker_username") ?? ""; }
        catch { return ""; }
    }

    /** @param {number} generation @param {string} account */
    current(generation, account){
        return this.active() && generation === this.generation && account === this.currentAccount();
    }

    /** @param {MessageEvent} event */
    receive(event){
        /** @type {{marketHistory?:{kind?:unknown,data?:unknown}}|null} */
        let message = null;
        try { message = typeof event.data === "string" ? JSON.parse(event.data) : event.data; }
        catch { return; }
        const history = message?.marketHistory;
        if (!history || (history.kind !== "sales" && history.kind !== "trades")) return;
        this.capture(history.data, history.kind);
    }

    /** @param {any} body @param {"sales"|"trades"} kind */
    capture(body, kind){
        if (!this.active() || body?.error) return;
        const account = this.currentAccount();
        const data = body?.data ?? body;
        const rows = kind === "trades" ? data?.completed : data?.history;
        if (!Array.isArray(rows)) return;
        if (this.account !== account){ this.queue.clear(); this.sent.clear(); this.account = account; }
        const now = Date.now();
        for (const raw of rows.slice(0, 500)){
            const row = kind === "trades" ? contributedTrade(raw, now) : contributedSale(raw, now);
            if (!row) continue;
            const key = kind + JSON.stringify(row);
            if (!this.sent.has(key)) this.queue.set(key, { kind, row });
        }
        while (this.queue.size > 300) this.queue.delete(this.queue.keys().next().value ?? "");
        this.schedule();
    }

    schedule(){
        clearTimeout(this.timer);
        if (!this.running || !this.queue.size) return;
        const delay = Math.max(100, this.nextPostAt - Date.now(), marketApi.retryAt - Date.now());
        this.timer = window.setTimeout(() => { void this.flush(); }, delay);
    }

    async flush(){
        if (!this.running || this.controller || !this.queue.size) return;
        if (this.account !== this.currentAccount()){ this.queue.clear(); this.sent.clear(); return; }
        if (!this.active() || Date.now() < Math.max(this.nextPostAt, marketApi.retryAt)){
            this.nextPostAt = Math.max(this.nextPostAt, Date.now() + 10_000);
            this.schedule();
            return;
        }
        const {generation} = this; const {account} = this;
        const batch = [...this.queue].slice(0, 100);
        /** @type {{sales:object[],trades:object[]}} */
        const body = { sales: [], trades: [] };
        for (const [, entry] of batch) body[entry.kind].push(entry.row);
        const controller = new AbortController();
        this.controller = controller;
        this.nextPostAt = Date.now() + 10_000;
        try {
            const result = await marketApi.observe(body, controller.signal);
            if (!result) throw new Error("contribution unavailable");
            // sent is sent, a pointer lock during the post must not queue the batch again
            if (generation !== this.generation || account !== this.currentAccount()) return;
            for (const [key] of batch){ this.queue.delete(key); this.sent.add(key); }
            while (this.sent.size > 1000) this.sent.delete(this.sent.values().next().value ?? "");
            this.failures = 0;
        }
        catch {
            if (generation === this.generation){
                this.failures++;
                this.nextPostAt = Date.now() + Math.min(60_000, 5000 * 2 ** Math.min(this.failures - 1, 4));
            }
        }
        finally {
            if (this.controller === controller){
                this.controller = null;
                this.schedule();
            }
        }
    }
}

const contrib = new Contributions();
export default contrib;
