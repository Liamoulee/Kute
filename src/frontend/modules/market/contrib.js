import marketApi from "./api.js";

// what the player shares: their own completed market sales and trades, read from the game's api with
// the player's own token right here in the page (the token never leaves it, like externalQueue.js does)
// and posted to kute without names or ids of anyone. once an hour per page load at most

const GAPI = "https://gapi.svc.krunker.io";
const LAST_KEY = "kute_market_contributed";
const INTERVAL_MS = 60 * 60 * 1000;
/** the first read waits for the menu to settle and the session to exist */
const FIRST_DELAY_MS = 45_000;
const TIMEOUT_MS = 8000;
const PAGE = 100;

/**
 * @typedef {{marketid: number, type: "sell"|"buy", date: string, skinindex: number, amount: number, status: string}} HistoryRow
 * @typedef {{trid: number, date?: string, created_at?: string, status?: string, sksell?: unknown[], skbuy?: unknown[], csell?: number, cbuy?: number}} TradeRow
 */

class Contributions {
    constructor(){
        /** @type {number|undefined} */
        this.timer = undefined;
        this.busy = false;
    }

    start(){
        if (this.timer !== undefined) return;
        this.timer = window.setTimeout(() => this.tick(), FIRST_DELAY_MS);
    }

    stop(){
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    async tick(){
        this.timer = window.setTimeout(() => this.tick(), INTERVAL_MS);
        if (this.busy) return;
        const last = Number(localStorage.getItem(LAST_KEY) ?? 0);
        if (Date.now() - last < INTERVAL_MS) return;
        this.busy = true;
        try {
            await this.contribute();
            localStorage.setItem(LAST_KEY, String(Date.now()));
        }
        catch {
            // the next hour tries again
        }
        finally {
            this.busy = false;
        }
    }

    /**
     * @param {string} path
     * @return {Promise<any>} the data of the game's envelope, null without a token or on failure
     */
    async read(path){
        const token = localStorage.getItem("__FRVR_auth_access_token");
        if (!token) return null;
        try {
            const response = await fetch(GAPI + path, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!response.ok) return null;
            const body = await response.json();
            return body?.error ? null : body?.data ?? null;
        }
        catch {
            return null;
        }
    }

    async contribute(){
        if (!marketApi.loggedIn() || !await marketApi.session()) return;
        const since = Date.now() - 48 * 3_600_000;

        /** @type {HistoryRow[]} */
        const history = (await this.read(`/market/history?sort=date_desc&limit=${PAGE}`))?.history ?? [];
        const sales = history
            .filter((row) => Number.isInteger(row.marketid) && Date.parse(row.date) >= since && (row.type === "sell" || row.type === "buy"))
            .map((row) => ({ marketid: row.marketid, type: row.type, skinindex: row.skinindex, amount: row.amount, date: row.date }));

        /** @type {TradeRow[]} */
        const trades = (await this.read(`/trades/history?offset=0&limit=${PAGE}&include_open=false`))?.trades ?? [];
        const done = trades
            .map((row) => {
                const at = Date.parse(row.date ?? row.created_at ?? "");
                if (!Number.isInteger(row.trid) || !(at >= since)) return null;
                const items = (/** @type {unknown[]} */ list) => list.map((entry) => this.item(entry)).filter((entry) => entry !== null);
                return { trid: row.trid, at, context: "history", give: items(row.sksell ?? []), get: items(row.skbuy ?? []), giveKr: Number(row.csell ?? 0) || 0, getKr: Number(row.cbuy ?? 0) || 0 };
            })
            .filter((row) => row !== null && row.give.length + row.get.length > 0);

        if (!sales.length && !done.length) return;
        await marketApi.observe({ sales, trades: done });
    }

    /**
     * the game's trade items come as objects with the skin index under one of a few keys
     *
     * @param {unknown} entry
     * @return {{skin: number, count: number, serial?: number, wear?: number}|null}
     */
    item(entry){
        if (typeof entry === "number") return { skin: entry, count: 1 };
        if (!entry || typeof entry !== "object") return null;
        const e = /** @type {Record<string, unknown>} */ (entry);
        const skin = [e.skinindex, e.skin_index, e.i, e.index, e.ind].find((v) => typeof v === "number");
        if (typeof skin !== "number") return null;
        const count = [e.count, e.cnt, e.c].find((v) => typeof v === "number");
        /** @type {{skin: number, count: number, serial?: number, wear?: number}} */
        const out = { skin, count: typeof count === "number" && count > 0 ? count : 1 };
        const meta = typeof e.m === "string" ? this.meta(e.m) : /** @type {Record<string, unknown>|null} */ (e.metadata ?? e.meta ?? null);
        if (meta && typeof meta.serial === "number") out.serial = meta.serial;
        if (meta && typeof meta.wear === "number") out.wear = meta.wear;
        return out;
    }

    /**
     * @param {string} text
     * @return {Record<string, unknown>|null}
     */
    meta(text){
        try {
            return JSON.parse(text);
        }
        catch {
            return null;
        }
    }
}

const contrib = new Contributions();
export default contrib;
