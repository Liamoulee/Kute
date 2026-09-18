// The one door to the Kute server (clan colors, the Kute badge, telemetry). The client has to play the same with
// the server gone, so: one health check per page load, and when it fails nothing talks to the server until the
// next load. A server that dies later gets the same treatment after a few failed requests in a row.
// Every request has a timeout, nothing here ever throws.

import { kute } from "../client.js";

const HEALTH_TIMEOUT_MS = 4000;
const REQUEST_TIMEOUT_MS = 5000;
/** this many failed requests in a row and the server counts as gone for the rest of the page load */
const MAX_FAILURES = 3;

class Api {
    constructor(){
        /** can be pointed at a local server from CDP for testing, before the first request */
        this.base = "https://kute.lol/api";
        /** @type {Promise<boolean> | null} */
        this.health = null;
        this.down = false;
        this.failures = 0;
    }

    /**
     * @return {Promise<boolean>} Whether the server answered its health check on this page load (asked once)
     */
    available(){
        this.health ??= this.check();
        return this.health;
    }

    /**
     * @return {Promise<boolean>}
     */
    async check(){
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
     * A JSON request to the server, or nothing at all when it is down.
     *
     * @param {string} path "/meta"
     * @param {RequestInit} [init]
     * @return {Promise<any>} The parsed answer, null when the server is down or the request failed
     */
    async request(path, init = {}){
        if (!await this.available() || this.down) return null;
        try {
            const response = await fetch(this.base + path, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            // an answer of any kind means the server is there, only silence counts against it
            this.failures = 0;
            return response.ok ? await response.json() : null;
        }
        catch {
            this.failures++;
            if (this.failures >= MAX_FAILURES) this.down = true;
            return null;
        }
    }
}

const api = new Api();
kute.api = api;
export default api;
