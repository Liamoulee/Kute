import { kute, ready } from "../client.js";

const HEALTH_TIMEOUT_MS = 4000;
const REQUEST_TIMEOUT_MS = 5000;
/** failures in a row until the server is off for this page load */
const MAX_FAILURES = 3;

class Api {
    constructor(){
        /** from the host, KUTE_API_URL overrides it for dev */
        this.base = typeof kute.apiBase === "string" ? kute.apiBase : "https://kute.lol/api";
        /** @type {Promise<boolean> | null} */
        this.health = null;
        this.down = false;
        this.failures = 0;
        /** @type {Set<(online: boolean) => void>} */
        this.listeners = new Set();
        kute.settings.toggleDisableOnlineFeatures = (disabled) => this.setOffline(disabled);
    }

    /**
     * @return {boolean} the player switched every contact with our server off
     */
    offline(){
        return kute.settings?.data?.disableOnlineFeatures === true;
    }

    /**
     * @param {boolean} offline
     */
    setOffline(offline){
        this.health = offline ? Promise.resolve(false) : null;
        this.down = offline;
        this.failures = 0;
        for (const listener of this.listeners) listener(!offline);
    }

    /**
     * @return {Promise<boolean>} health check, once per page load
     */
    available(){
        this.health ??= this.check();
        return this.health;
    }

    /** a deliberate retry from a view can check a server that was previously unavailable */
    retry(){
        this.health = null;
        this.down = false;
        this.failures = 0;
        return this.available();
    }

    /**
     * @return {Promise<boolean>}
     */
    async check(){
        await ready;
        if (this.offline()){
            this.down = true;
            return false;
        }
        try {
            const response = await fetch(`${this.base}/health`, { cache: "no-store", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
            const health = response.ok ? await response.json() : null;
            this.down = health?.ok !== true;
        }
        catch {
            this.down = true;
        }
        return !this.down;
    }

    /**
     * @param {string} path "/meta"
     * @param {RequestInit} [init]
     * @return {Promise<any>} parsed json, null when down or failed
     */
    async request(path, init = {}){
        const { data } = await this.requestStatus(path, init);
        return data;
    }

    /**
     * the same request with the status, for callers that act on a 401 or a 429
     *
     * @param {string} path
     * @param {RequestInit} [init]
     * @return {Promise<{status: number, data: any, error?: any}>} status 0 when down, offline or failed, error the body of a non 2xx
     */
    async requestStatus(path, init = {}){
        if (!await this.available() || this.down || this.offline()) return { status: 0, data: null };
        try {
            const response = await fetch(this.base + path, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            // any answer means it's alive, only silence counts
            this.failures = 0;
            const data = await response.json().catch(() => null);
            return { status: response.status, data: response.ok ? data : null, error: response.ok ? null : data };
        }
        catch {
            this.failures++;
            if (this.failures >= MAX_FAILURES) this.down = true;
            return { status: 0, data: null };
        }
    }
}

const api = new Api();
kute.api = api;
export default api;
