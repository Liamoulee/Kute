import { kute } from "../../client.js";
import api from "../api.js";
import marketApi from "./api.js";
import { readWatchlist } from "./watchlist.js";
import { formatKr } from "./types.js";

const INTERVAL = 5 * 60_000;
const MAX_AGE = 3 * 3_600_000;
const STATE_KEY = "kute_market_alerts";

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
        this.onChange = () => { void this.check(); };
    }

    start(){
        if (this.timer) return;
        this.timer = window.setInterval(() => { void this.check(); }, INTERVAL);
        window.addEventListener("kute-market-watch-changed", this.onChange);
        void this.check();
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

    async check(){
        if (this.busy || !this.active()) return;
        const watch = readWatchlist().filter((w) => w.target !== null);
        for (const skin of this.seen.keys()) if (!watch.some((w) => w.skin === skin)) this.seen.delete(skin);
        this.save();
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
                if (reached && (!previous?.reached || previous.target !== w.target)) hits.push({ name: w.name, price: v.lowest });
                this.seen.set(w.skin, { target: w.target, reached });
            }
            if (hits.length){
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
