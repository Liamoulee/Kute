import api from "../api.js";
import marketApi from "./api.js";
import { contributedSale, contributedTrade } from "./contributionData.js";

/** @param {RequestInfo|URL} input @param {RequestInit} [init] @return {"sales"|"trades"|null} */
function historyKind(input, init){
    try {
        const request = input instanceof Request ? input : null;
        if ((init?.method ?? request?.method ?? "GET").toUpperCase() !== "GET") return null;
        const url = new URL(request ? request.url : String(input), location.href);
        if (url.origin !== "https://gapi.svc.krunker.io") return null;
        if (url.pathname === "/trades/history") return "trades";
        if (url.pathname === "/market/history") return "sales";
    }
    catch { /* unrelated requests must behave exactly as the game expects */ }
    return null;
}

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
        /** @type {typeof fetch|null} */
        this.originalFetch = null;
        /** @type {typeof fetch|null} */
        this.observer = null;
        /** @type {number|undefined} */
        this.timer = undefined;
        /** @type {AbortController|null} */
        this.controller = null;
    }

    start(){
        if (this.running) return;
        this.running = true;
        const generation = ++this.generation;
        const original = window.fetch;
        this.originalFetch = original;
        this.observer = (input, init) => {
            const kind = this.active() ? historyKind(input, init) : null;
            const account = kind ? this.currentAccount() : "";
            const pending = original.call(window, input, init);
            if (kind){
                // clone only history; never consume the game's response or inspect its credentials
                void pending.then(response => {
                    if (response.ok && this.current(generation, account)){
                        return this.capture(response.clone(), kind, generation, account);
                    }
                    return undefined;
                }).catch(() => {});
            }
            return pending;
        };
        window.fetch = this.observer;
    }

    stop(){
        this.running = false;
        this.generation++;
        clearTimeout(this.timer);
        this.controller?.abort();
        this.controller = null;
        this.queue.clear();
        this.sent.clear();
        if (window.fetch === this.observer && this.originalFetch) window.fetch = this.originalFetch;
        this.observer = null;
        this.originalFetch = null;
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

    /** @param {Response} response @param {"sales"|"trades"} kind @param {number} generation @param {string} account */
    async capture(response, kind, generation, account){
        const body = await response.json();
        if (!this.current(generation, account) || body?.error) return;
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
            if (!this.current(generation, account)) return;
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
