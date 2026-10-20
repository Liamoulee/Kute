import { kute } from "../../client.js";
import api from "../api.js";
import marketApi from "./api.js";
import { readWatchlist } from "./watchlist.js";
import { formatKr } from "./types.js";

const INTERVAL = 5 * 60_000;
const MAX_AGE = 3 * 3_600_000;
const STATE_KEY = "kute_market_alerts";
const REPORT_KEY = "kute_market_watch_report";
const UNREAD_KEY = "kute_market_alerts_unread";
export const UNREAD_EVENT = "kute-market-alerts-unread";
// the server keeps watched ids in memory, a restart forgets them until the next report
const REPORT_EVERY = 2 * 3_600_000;

class WatchAlerts {
    constructor(){
        this.timer = 0;
        this.busy = false;
        /** @type {Map<number,{target:number,reached:boolean}>} */
        this.seen = new Map();
        try {
            const saved = JSON.parse(localStorage.getItem(STATE_KEY) ?? "[]");
            if (Array.isArray(saved)){
                for (const [skin, state] of saved.slice(0, 100)){
                    if (Number.isInteger(skin) && Number.isFinite(state?.target) && typeof state?.reached === "boolean") this.seen.set(skin, state);
                }
            }
        }
        catch {
            this.seen.clear();
        }
        /** @type {Set<number>} skins that reached their target since the watchlist was last opened */
        this.unread = new Set();
        try {
            const saved = JSON.parse(localStorage.getItem(UNREAD_KEY) ?? "[]");
            if (Array.isArray(saved)) for (const skin of saved.slice(0, 100)) if (Number.isInteger(skin)) this.unread.add(skin);
        }
        catch {
            this.unread.clear();
        }
        this.onChange = () => {
            void this.check();
            void this.report();
        };
    }

    start(){
        if (this.timer) return;
        this.timer = window.setInterval(() => { void this.check(); }, INTERVAL);
        window.addEventListener("kute-market-watch-changed", this.onChange);
        void this.check();
        void this.report();
    }

    /** tells the server which skins to read more often: ids only, when they change or the last report got old */
    async report(){
        if (!this.active()) return;
        const skins = readWatchlist().map((w) => w.skin).sort((a, b) => a - b);
        const key = skins.join(",");
        /** @type {{key?:string,at?:number}} */
        let last = {};
        try { last = JSON.parse(localStorage.getItem(REPORT_KEY) ?? "{}") ?? {}; }
        catch { /* reports again */ }
        if (last.key === key && Date.now() - (last.at ?? 0) < REPORT_EVERY) return;
        // nothing watched and nothing reported: the server has nothing to forget
        if (!skins.length && last.key === undefined) return;
        if (!await marketApi.watch(skins)) return;
        try { localStorage.setItem(REPORT_KEY, JSON.stringify({ key, at: Date.now() })); }
        catch { /* reports again on the next load */ }
    }

    stop(){
        clearInterval(this.timer);
        this.timer = 0;
        window.removeEventListener("kute-market-watch-changed", this.onChange);
    }

    active(){
        return !!this.timer && !document.pointerLockElement && !document.hidden && !api.offline() && marketApi.loggedIn();
    }

    save(){
        try { localStorage.setItem(STATE_KEY, JSON.stringify([...this.seen])); }
        catch { /* keep the current page's alert state when storage is unavailable */ }
    }

    saveUnread(){
        try { localStorage.setItem(UNREAD_KEY, JSON.stringify([...this.unread])); }
        catch { /* the badge lives for this page load */ }
        window.dispatchEvent(new Event(UNREAD_EVENT));
    }

    /** the watchlist was opened */
    markRead(){
        if (!this.unread.size) return;
        this.unread.clear();
        this.saveUnread();
    }

    async check(){
        if (this.busy || !this.active()) return;
        const watch = readWatchlist().filter((w) => w.target !== null);
        for (const skin of this.seen.keys()) if (!watch.some((w) => w.skin === skin)) this.seen.delete(skin);
        this.save();
        const unread = this.unread.size;
        for (const skin of this.unread) if (!watch.some((w) => w.skin === skin)) this.unread.delete(skin);
        if (this.unread.size !== unread) this.saveUnread();
        if (!watch.length) return;
        this.busy = true;
        try {
            const values = await marketApi.values(watch.map((w) => w.skin));
            if (!this.active()) return;
            const latest = readWatchlist();
            const hits = [];
            for (const w of watch){
                if (w.target === null || !latest.some((i) => i.skin === w.skin && i.target === w.target)) continue;
                const v = values[w.skin];
                if (!v || !v.bookAt || !v.valuedAt || Date.now() - Math.min(v.bookAt, v.valuedAt) > MAX_AGE || v.lowest === null) continue;
                const reached = v.lowest <= w.target;
                const previous = this.seen.get(w.skin);
                if (reached && (!previous?.reached || previous.target !== w.target)){
                    hits.push({ name: w.name, price: v.lowest });
                    this.unread.add(w.skin);
                }
                this.seen.set(w.skin, { target: w.target, reached });
            }
            if (hits.length){
                this.saveUnread();
                const first = hits[0];
                const more = hits.length > 1 ? ` and ${hits.length - 1} more` : "";
                kute.showNotification(`Watchlist: ${first.name} at ${formatKr(first.price)} KR${more}. Observed ask reached your target.`, false, 8);
            }
            this.save();
        }
        catch {
            // retry on the next menu check
        }
        finally {
            this.busy = false;
        }
    }
}

const alerts = new WatchAlerts();
export default alerts;
