import { kute } from "../../client.js";
import api from "../api.js";

// the one door of the market module to kute.lol: a session from the exe's attestation, then reads with
// the session header; a 401 renews once, every answer is cached for its own ttl so a card walk or a
// trade window redraw never repeats a request

const SESSION_KEY = "kute_market_session";
const SESSION_HEADER = "x-kute-session";
/** the host's reply to market-attest has to arrive within this */
const ATTEST_TIMEOUT_MS = 3000;
/** sessions last 24 h on the server, renew before */
const SESSION_MARGIN_MS = 60 * 60 * 1000;

/**
 * @typedef {{session: string, expiresAt: number}} StoredSession
 * @typedef {{marketAttest?: {challenge: string, sig: string|null, version: string, loggedIn: boolean, keyed: boolean}}} AttestReply
 */

class MarketApi {
    constructor(){
        /** @type {Promise<string|null>|null} */
        this.sessionPromise = null;
        /** @type {StoredSession|null} */
        this.memorySession = null;
        /** @type {Map<string, {at: number, ttl: number, value: Promise<any>}>} */
        this.cache = new Map();
        /** why the last session attempt failed, shown in the terminal */
        this.lastError = "";
        this.retryAt = 0;
    }

    /** @return {boolean} the game has a login, the only state a session is issued for */
    loggedIn(){
        try { return localStorage.getItem("krunker_token") !== null; }
        catch { return false; }
    }

    /** @return {boolean} the exe can sign challenges */
    hostSupported(){
        return kute.hostFeatures?.includes("market-attest") === true;
    }

    /** @return {StoredSession|null} */
    stored(){
        if (this.memorySession && Date.now() < this.memorySession.expiresAt - SESSION_MARGIN_MS) return this.memorySession;
        try {
            const raw = localStorage.getItem(SESSION_KEY);
            if (!raw) return null;
            const parsed = /** @type {StoredSession} */ (JSON.parse(raw));
            if (typeof parsed.session !== "string" || Date.now() > parsed.expiresAt - SESSION_MARGIN_MS) return null;
            return parsed;
        }
        catch {
            return null;
        }
    }

    /**
     * @param {string} session the one the server refused; parallel 401s of it must not each start a new flow
     */
    forget(session){
        if (this.stored()?.session !== session) return;
        try { localStorage.removeItem(SESSION_KEY); }
        catch { /* the in-memory session can still be renewed */ }
        this.memorySession = null;
    }

    /**
     * asks the host to sign a challenge
     *
     * @param {string} challenge
     * @return {Promise<AttestReply["marketAttest"]|null>}
     */
    attest(challenge){
        return new Promise((resolve) => {
            let timer = 0;
            /** @param {MessageEvent<AttestReply>} event */
            const listener = (event) => {
                // the host's json arrives as text on this path
                /** @type {AttestReply|null} */
                let data = null;
                try {
                    data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
                }
                catch {
                    return;
                }
                const reply = data?.marketAttest;
                if (!reply || reply.challenge !== challenge) return;
                clearTimeout(timer);
                window.chrome.webview.removeEventListener("message", listener);
                resolve(reply);
            };
            timer = window.setTimeout(() => {
                window.chrome.webview.removeEventListener("message", listener);
                resolve(null);
            }, ATTEST_TIMEOUT_MS);
            window.chrome.webview.addEventListener("message", listener);
            // the host splits on ", "; the challenge is base64url and never contains a comma
            window.chrome.webview.postMessage(`market-attest, ${challenge}, ${this.loggedIn()}`);
        });
    }

    /**
     * @return {Promise<string|null>} a session, one flow at a time
     */
    session(){
        const stored = this.stored();
        if (stored) return Promise.resolve(stored.session);
        this.sessionPromise ??= this.newSession().finally(() => {
            this.sessionPromise = null;
        });
        return this.sessionPromise;
    }

    /**
     * @return {Promise<string|null>}
     */
    async newSession(){
        this.lastError = "";
        if (!this.loggedIn()){
            this.lastError = "log in to Krunker to use the market";
            return null;
        }
        if (!this.hostSupported()){
            this.lastError = "this Kute version cannot sign in to the market, update Kute";
            return null;
        }
        const challenge = await api.requestStatus("/market/session", { method: "POST" });
        if (!challenge.data?.challenge){
            this.lastError = challenge.status === 503 ? "the market is not available right now" : "could not reach the market";
            if (challenge.status === 429) this.limited(challenge.retryAt);
            return null;
        }
        const signed = await this.attest(challenge.data.challenge);
        if (!signed){
            this.lastError = "Kute did not answer the sign in";
            return null;
        }
        const confirm = await api.requestStatus("/market/session/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ challenge: signed.challenge, sig: signed.sig, version: signed.version, loggedIn: signed.loggedIn }),
        });
        if (!confirm.data?.session){
            this.lastError = typeof confirm.error?.error === "string" ? confirm.error.error : "the market refused the sign in";
            if (confirm.status === 429) this.limited(confirm.retryAt);
            return null;
        }
        this.memorySession = { session: confirm.data.session, expiresAt: confirm.data.expiresAt };
        try {
            localStorage.setItem(SESSION_KEY, JSON.stringify(this.memorySession));
        }
        catch {
            // storage full or blocked, the session lives for this page load
        }
        return confirm.data.session;
    }

    /**
     * a market request with the session, renewed once on a 401
     *
     * @param {string} path "/market/value?ids=1"
     * @param {RequestInit} [init]
     * @param {boolean} [retried]
     * @return {Promise<any>} the body, null when anything failed
     */
    async request(path, init = {}, retried = false){
        return (await this.requestStatus(path, init, retried)).data;
    }

    /** @param {string} path @param {RequestInit} [init] @param {boolean} [retried] @return {Promise<{status:number,data:any,retryAt?:number}>} */
    async requestStatus(path, init = {}, retried = false){
        if (Date.now() < this.retryAt) return { status: 429, data: null, retryAt: this.retryAt };
        const session = await this.session();
        if (!session) return { status: 0, data: null };
        const headers = { ...(init.headers ?? {}), [SESSION_HEADER]: session };
        // the module and server own the TTL; a second browser cache can outlive either one
        const result = await api.requestStatus(path, { ...init, headers, cache: "no-store" });
        if (result.status === 401 && !retried){
            this.forget(session);
            return this.requestStatus(path, init, true);
        }
        if (result.status === 429){
            this.limited(result.retryAt);
        }
        else this.lastError = result.data === null && result.status !== 404 ? "The market is temporarily unavailable. Please try again shortly." : "";
        return result;
    }

    /** @param {number} [retryAt] */
    limited(retryAt){
        this.retryAt = retryAt ?? Date.now() + 60_000;
        this.lastError = `Market request limit reached. Try again after ${new Date(this.retryAt).toLocaleTimeString()}.`;
    }

    /**
     * @param {string} path
     * @param {number} ttlMs
     * @param {() => Promise<any>} [read]
     * @return {Promise<any>}
     */
    cached(path, ttlMs, read = () => this.request(path)){
        const now = Date.now();
        const hit = this.cache.get(path);
        if (hit && now - hit.at < hit.ttl) return hit.value;
        const value = read().then((data) => {
            // a failed answer is not kept, the next caller tries again
            if (data === null) this.cache.delete(path);
            return data;
        });
        this.cache.set(path, { at: now, ttl: ttlMs, value });
        if (this.cache.size > 500){
            const oldest = this.cache.keys().next();
            if (!oldest.done) this.cache.delete(oldest.value);
        }
        return value;
    }

    retry(){
        if (Date.now() < this.retryAt) return Promise.resolve(false);
        this.cache.clear();
        return api.retry();
    }

    /** @param {number} skin @param {string} range */
    async itemDesk(skin, range){
        const path = `/market/item/${skin}/desk?range=${range}`;
        return this.cached(path, 60_000, async() => {
            const result = await this.requestStatus(path);
            if (result.status !== 404) return result.data;
            // older servers expose the three original endpoints
            const item = await this.cached(`/market/item/${skin}`, 300_000);
            if (!item) return null;
            const [history, listings] = await Promise.all([
                this.cached(`/market/item/${skin}/history?range=${range}`, 300_000),
                this.cached(`/market/item/${skin}/listings`, 60_000),
            ]);
            return { item, history, listings };
        });
    }

    /**
     * @param {number[]} skins
     * @return {Promise<Record<string, import("./types.js").SkinValue>>}
     */
    async values(skins){
        const ids = [...new Set(skins)].sort((a, b) => a - b);
        /** @type {Record<string, import("./types.js").SkinValue>} */
        const out = {};
        for (let i = 0; i < ids.length; i += 100){
            const reply = await this.cached(`/market/value?ids=${ids.slice(i, i + 100).join(",")}`, 5 * 60 * 1000);
            Object.assign(out, reply?.values ?? {});
        }
        return out;
    }

    /**
     * @param {string[]} paths preview image paths after textures/previews/
     * @return {Promise<Record<string, import("./types.js").SkinValue>>}
     */
    async valuesByThumbnails(paths){
        const unique = [...new Set(paths)].sort();
        /** @type {Record<string, import("./types.js").SkinValue>} */
        const out = {};
        for (let i = 0; i < unique.length; i += 100){
            const reply = await this.cached(`/market/value?thumbs=${encodeURIComponent(unique.slice(i, i + 100).join(","))}`, 5 * 60 * 1000);
            Object.assign(out, reply?.values ?? {});
        }
        return out;
    }

    /**
     * @param {import("./types.js").TradeInput} trade
     * @return {Promise<import("./types.js").TradeVerdict|null>}
     */
    analyze(trade){
        return this.request("/market/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(trade) });
    }

    /** @param {import("./types.js").TradeInput} trade */
    analyzeStatus(trade){
        return this.requestStatus("/market/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(trade) });
    }

    /** @param {object} body @param {AbortSignal} [signal] */
    observe(body, signal){
        return this.request("/market/observe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    }

    /** @param {number[]} skins @return {Promise<{watched:number}|null>} */
    watch(skins){
        return this.request("/market/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skins }) });
    }
}

const marketApi = new MarketApi();
export default marketApi;
