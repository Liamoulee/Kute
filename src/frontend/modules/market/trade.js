import marketApi from "./api.js";
import { GRADE_COLORS, formatKr, formatPercent } from "./types.js";

// the verdict under both trade windows. the legacy window (windows[36]) names skins in its element ids,
// the svelte one only shows preview images, whose paths name the skin. the window is read, never
// touched; polling at a slow rate replaces an observer, and nothing runs while the pointer is locked

const POLL_MS = 1200;
const BOX_CLASS = "kuteTradeBox";
const STYLE_ID = "kuteMarketTradeStyle";
const CSS = `
.${BOX_CLASS}{margin:6px 0 0;padding:8px 10px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;font-size:14px;line-height:1.35;font-weight:700;text-align:left}
.${BOX_CLASS} .kuteVerdict{font-size:16px;margin-bottom:2px}
.${BOX_CLASS} .kuteSides{display:flex;justify-content:space-between;gap:12px;opacity:.9;font-size:13px}
.${BOX_CLASS} .kuteDrivers{margin-top:4px;font-weight:500;font-size:12px;opacity:.85}
.${BOX_CLASS}.good .kuteVerdict{color:#5ce05a}.${BOX_CLASS}.bad .kuteVerdict{color:#f44336}.${BOX_CLASS}.fair .kuteVerdict{color:#9ccc65}.${BOX_CLASS}.uncertain .kuteVerdict{color:#fbc02d}
.${BOX_CLASS} .kuteGrade{display:inline-block;min-width:14px;text-align:center;border-radius:3px;padding:0 3px;color:#111;font-size:11px;margin-left:3px}
`;
const VERDICT_TEXT = { good: "More estimated value coming in", bad: "More estimated value going out", fair: "Similar estimated value", uncertain: "Too little data to judge" };

/**
 * @typedef {{give: import("./types.js").TradeItem[], get: import("./types.js").TradeItem[], giveKr: number, getKr: number, anchor: Element, key: string}} Snapshot
 */

class TradeWindows {
    constructor(){
        /** @type {number|undefined} */
        this.timer = undefined;
        this.lastKey = "";
        this.busy = false;
        /** @type {HTMLDivElement|null} */
        this.box = null;
    }

    start(){
        if (this.timer !== undefined) return;
        if (!document.getElementById(STYLE_ID)){
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.append(style);
        }
        this.timer = window.setInterval(() => this.tick(), POLL_MS);
    }

    stop(){
        clearInterval(this.timer);
        this.timer = undefined;
        this.box?.remove();
        this.box = null;
        this.lastKey = "";
    }

    /**
     * @param {string} text "12,345 KR" or "~ 12345"
     * @return {number}
     */
    static kr(text){
        const match = /([\d,.]+)/.exec(text.replace(/[~\s]/g, ""));
        return match ? Number(match[1].replace(/,/g, "")) || 0 : 0;
    }

    /**
     * the legacy window: offer lists with ids trd_<side>_<skin>[_<instance>] and the kr inputs offerVal0/1
     *
     * @return {Snapshot|null}
     */
    legacy(){
        const lists = [document.getElementById("tradeList0"), document.getElementById("tradeList1")];
        if (!lists[0] || !lists[1]) return null;
        const holder = lists[0].closest("#tradeHolder, .tradeHolder, [id^='trade']") ?? lists[0].parentElement;
        if (!holder || holder.getClientRects().length === 0) return null;
        /** @param {Element} list */
        const items = (list) => {
            /** @type {Map<number, import("./types.js").TradeItem>} */
            const out = new Map();
            for (const node of list.querySelectorAll("[id^='trd_']")){
                const match = /^trd_(?:inv_)?\d+_(\d+)(?:_(\d+))?$/.exec(node.id);
                if (!match || node.id.startsWith("trd_inv_")) continue;
                const skin = Number(match[1]);
                const count = TradeWindows.kr(node.querySelector(".tItemCnt")?.textContent?.replace("x", "") ?? "1") || 1;
                const existing = out.get(skin);
                if (existing) existing.count += count;
                else out.set(skin, { skin, count });
            }
            return [...out.values()];
        };
        const kr = (/** @type {string} */ id) => {
            const el = document.getElementById(id);
            return el instanceof HTMLInputElement ? Number(el.value) || 0 : TradeWindows.kr(el?.textContent ?? "0");
        };
        const give = items(lists[0]);
        const get = items(lists[1]);
        const anchor = document.getElementById("tradeTotal0")?.parentElement ?? lists[1].parentElement ?? lists[1];
        return { give, get, giveKr: kr("offerVal0"), getKr: kr("offerVal1"), anchor, key: JSON.stringify([give, get, kr("offerVal0"), kr("offerVal1")]) };
    }

    /**
     * the svelte window: two .trade-side blocks, items as preview images in .trade-offer-scroll, kr in .trade-est
     *
     * @return {Promise<Snapshot|null>}
     */
    async svelte(){
        const sides = [...document.querySelectorAll(".trade-window .trade-side, .trade-side")];
        if (sides.length < 2 || sides[0].getClientRects().length === 0) return null;
        /** @type {string[][]} */
        const paths = sides.slice(0, 2).map((side) => [...side.querySelectorAll(".trade-offer-scroll img")].map((img) => {
            const match = /\/textures\/previews\/([^?#]+)/.exec(img instanceof HTMLImageElement ? img.currentSrc || img.src : "");
            return match ? match[1] : "";
        }).filter(Boolean));
        const key = JSON.stringify(paths);
        if (!paths[0].length && !paths[1].length) return { give: [], get: [], giveKr: 0, getKr: 0, anchor: sides[1], key };
        const values = await marketApi.valuesByThumbnails([...paths[0], ...paths[1]]);
        /** @param {string[]} list */
        const items = (list) => {
            /** @type {Map<number, import("./types.js").TradeItem>} */
            const out = new Map();
            for (const path of list){
                const skin = values[path]?.skin;
                if (skin === undefined) continue;
                const existing = out.get(skin);
                if (existing) existing.count++;
                else out.set(skin, { skin, count: 1 });
            }
            return [...out.values()];
        };
        return { give: items(paths[0]), get: items(paths[1]), giveKr: 0, getKr: 0, anchor: sides[1], key };
    }

    async tick(){
        if (this.busy || document.pointerLockElement) return;
        this.busy = true;
        try {
            const snapshot = this.legacy() ?? await this.svelte();
            if (!snapshot){
                if (this.box){
                    this.box.remove();
                    this.box = null;
                    this.lastKey = "";
                }
                return;
            }
            if (snapshot.key === this.lastKey && this.box?.isConnected) return;
            this.lastKey = snapshot.key;
            if (!snapshot.give.length && !snapshot.get.length && !snapshot.giveKr && !snapshot.getKr){
                this.render(snapshot.anchor, null, "Add items to see Kute's verdict");
                return;
            }
            const verdict = await marketApi.analyze({ give: snapshot.give, get: snapshot.get, giveKr: snapshot.giveKr, getKr: snapshot.getKr });
            this.render(snapshot.anchor, verdict, verdict ? "" : "Kute Market is not reachable");
        }
        finally {
            this.busy = false;
        }
    }

    /**
     * @param {Element} anchor
     * @param {import("./types.js").TradeVerdict|null} verdict
     * @param {string} fallback
     */
    render(anchor, verdict, fallback){
        if (!this.box){
            this.box = document.createElement("div");
        }
        this.box.className = BOX_CLASS + (verdict ? ` ${verdict.verdict}` : "");
        if (!verdict){
            this.box.innerHTML = `<div class="kuteVerdict">Kute Market</div><div class="kuteDrivers">${fallback}</div>`;
        }
        else {
            /** @param {import("./types.js").TradeSide} side @param {string} label */
            const sideText = (side, label) => `<span>${label}: ${formatKr(side.value)} kr${side.items.filter((l) => !l.unknown).map((l) => `<span class="kuteGrade" style="background:${GRADE_COLORS[l.grade]}">${l.grade}</span>`).join("")}</span>`;
            const diff = verdict.difference === 0 ? "" : ` (${verdict.difference > 0 ? "+" : "-"}${formatKr(Math.abs(verdict.difference))} kr, ${formatPercent(verdict.differenceShare)})`;
            this.box.innerHTML = `<div class="kuteVerdict">${VERDICT_TEXT[verdict.verdict]}${diff}</div>`
                + `<div class="kuteSides">${sideText(verdict.give, "You give")}${sideText(verdict.get, "You get")}</div>`
                + (verdict.drivers.length ? `<div class="kuteDrivers">${verdict.drivers.map((d) => `• ${d}`).join("<br>")}</div>` : "");
        }
        if (this.box.parentElement !== anchor.parentElement || this.box.previousElementSibling !== anchor) anchor.after(this.box);
    }
}

const trade = new TradeWindows();
export default trade;
