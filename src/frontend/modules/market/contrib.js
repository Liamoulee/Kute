import { kute } from "../../client.js";
import api from "../api.js";
import marketApi from "./api.js";
import { contributedSale, contributedTrade } from "./contributionData.js";

// the host hands over the game's own completed history replies (modules/history.rs); nothing here
// touches fetch or another page global, krunker's cheat checks would see that

// the game shows the same history on every load; a report sent again after a server restart would count as a second source
const SENT_KEY = "kute_market_sent";
const MAX_SENT = 2000;

/** @param {string} text @return {string} two 32 bit fnv-1a hashes, a collision would only drop one report */
function shortHash(text){
    let a = 0x811c9dc5;
    let b = 0x050c5d1f;
    for (let i = 0; i < text.length; i++){
        a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
        b = Math.imul(b ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
    return a.toString(36) + b.toString(36);
}

/** @return {Set<string>} */
function loadSent(){
    try {
        const saved = JSON.parse(localStorage.getItem(SENT_KEY) ?? "[]");
        return new Set(Array.isArray(saved) ? saved.filter((h) => typeof h === "string").slice(-MAX_SENT) : []);
    }
    catch {
        return new Set();
    }
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
        /** @type {Set<string>} hashes of account and report, across page loads */
        this.sent = loadSent();
        /** @type {number|undefined} */
        this.timer = undefined;
        /** @type {AbortController|null} */
        this.controller = null;
        /** @type {Map<number,{skin:number,price:number}>} listings the game showed, by market id: what a captured buy paid */
        this.listings = new Map();
        /** @type {Map<number,object>} the player's open trades from the last trade list, by trade id */
        this.openTrades = new Map();
        /** @type {Set<number>} skins the game listed, the server reads their books sooner */
        this.seen = new Set();
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
        this.forgetCaptured();
    }

    /** @param {string} account what was captured belongs to this login, another one starts over */
    useAccount(account){
        if (this.account === account) return;
        this.queue.clear();
        this.forgetCaptured();
        this.account = account;
    }

    forgetCaptured(){
        this.listings.clear();
        this.openTrades.clear();
        this.seen.clear();
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
        /** @type {{marketHistory?:{kind?:unknown,data?:unknown},marketCapture?:{method?:unknown,path?:unknown,request?:any,data?:any}}|null} */
        let message = null;
        try { message = typeof event.data === "string" ? JSON.parse(event.data) : event.data; }
        catch { return; }
        // an exe with market-capture sends the two history replies both ways
        if (kute.hostFeatures?.includes("market-capture")){
            if (message?.marketCapture) this.captured(message.marketCapture);
            return;
        }
        const history = message?.marketHistory;
        if (!history || (history.kind !== "sales" && history.kind !== "trades")) return;
        this.capture(history.data, history.kind);
    }

    /**
     * every market and trade reply the game got; only completed buys and trades become reports
     *
     * @param {{method?:unknown,path?:unknown,request?:any,data?:any}} reply
     */
    captured(reply){
        if (typeof reply.path !== "string" || reply.data?.error) return;
        const path = reply.path.split(/[?#]/)[0];
        const data = reply.data?.data;
        if (reply.method === "GET"){
            if (path === "/market/history") this.capture(reply.data, "sales");
            else if (path === "/trades/history"){
                if (Array.isArray(data?.open)){
                    this.openTrades.clear();
                    for (const trade of data.open.slice(0, 100)) if (Number.isSafeInteger(trade?.trid)) this.openTrades.set(trade.trid, trade);
                }
                this.capture(reply.data, "trades");
            }
            else if (path === "/market/listings" && Array.isArray(data?.listings)) this.listed(data.listings);
            return;
        }
        if (reply.method !== "POST") return;
        if (path === "/market/purchase"){
            const listing = this.listings.get(data?.mid);
            // the history lists the same buy seconds later, the server keeps one report of it
            if (listing && listing.skin === data?.skn){
                const row = { marketid: data.mid, type: "buy", date: new Date().toISOString(), skinindex: data.skn, amount: listing.price, status: "completed" };
                this.capture({ history: [row] }, "sales");
            }
            return;
        }
        const accepted = /^\/trades\/(\d+)\/accept$/.exec(path);
        const trade = accepted && this.openTrades.get(Number(accepted[1]));
        if (trade) this.capture({ completed: [trade] }, "trades");
    }

    /** @param {any[]} rows */
    listed(rows){
        if (!this.active()) return;
        this.useAccount(this.currentAccount());
        for (const row of rows.slice(0, 200)){
            if (!Number.isSafeInteger(row?.marketid) || !Number.isSafeInteger(row?.skinindex) || !Number.isSafeInteger(row?.funds)) continue;
            this.listings.delete(row.marketid);
            this.listings.set(row.marketid, { skin: row.skinindex, price: row.funds });
            if (this.seen.size < 200) this.seen.add(row.skinindex);
        }
        while (this.listings.size > 3000) this.listings.delete(this.listings.keys().next().value ?? 0);
        this.schedule();
    }

    /** @param {any} body @param {"sales"|"trades"} kind */
    capture(body, kind){
        if (!this.active() || body?.error) return;
        const account = this.currentAccount();
        const data = body?.data ?? body;
        const rows = kind === "trades" ? data?.completed : data?.history;
        if (!Array.isArray(rows)) return;
        this.useAccount(account);
        const now = Date.now();
        for (const raw of rows.slice(0, 500)){
            const row = kind === "trades" ? contributedTrade(raw, now) : contributedSale(raw, now);
            if (!row) continue;
            const key = kind + JSON.stringify(row);
            if (!this.sent.has(shortHash(`${account}\n${key}`))) this.queue.set(key, { kind, row });
        }
        while (this.queue.size > 300) this.queue.delete(this.queue.keys().next().value ?? "");
        this.schedule();
    }

    schedule(){
        clearTimeout(this.timer);
        if (!this.running || !this.queue.size && !this.seen.size) return;
        const delay = Math.max(100, this.nextPostAt - Date.now(), marketApi.retryAt - Date.now());
        this.timer = window.setTimeout(() => { void this.flush(); }, delay);
    }

    async flush(){
        if (!this.running || this.controller || !this.queue.size && !this.seen.size) return;
        if (this.account !== this.currentAccount()){ this.queue.clear(); this.seen.clear(); return; }
        if (!this.active() || Date.now() < Math.max(this.nextPostAt, marketApi.retryAt)){
            this.nextPostAt = Math.max(this.nextPostAt, Date.now() + 10_000);
            this.schedule();
            return;
        }
        const {generation} = this; const {account} = this;
        const batch = [...this.queue].slice(0, 100);
        const seen = [...this.seen];
        /** @type {{sales:object[],trades:object[],seen:number[]}} */
        const body = { sales: [], trades: [], seen };
        for (const [, entry] of batch) body[entry.kind].push(entry.row);
        const controller = new AbortController();
        this.controller = controller;
        this.nextPostAt = Date.now() + 10_000;
        try {
            const result = await marketApi.observe(body, controller.signal);
            if (!result) throw new Error("contribution unavailable");
            // sent is sent, a pointer lock during the post must not queue the batch again
            if (generation !== this.generation || account !== this.currentAccount()) return;
            for (const [key] of batch){ this.queue.delete(key); this.sent.add(shortHash(`${account}\n${key}`)); }
            for (const skin of seen) this.seen.delete(skin);
            while (this.sent.size > MAX_SENT) this.sent.delete(this.sent.values().next().value ?? "");
            try { localStorage.setItem(SENT_KEY, JSON.stringify([...this.sent])); }
            catch { /* this page load still skips them */ }
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
