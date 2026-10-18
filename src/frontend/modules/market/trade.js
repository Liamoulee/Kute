import marketApi from "./api.js";
import { GRADE_COLORS, formatKr, formatPercent } from "./types.js";
import { esc, TRADE_VERDICTS } from "./presentation.js";
import template from "../../components/marketTrade.html";

const POLL_MS = 1200;

/**
 * @typedef {import("./types.js").TradeItem & {path?:string}} Entry
 * @typedef {{give:Entry[],get:Entry[],giveKr:number,getKr:number,anchor:Element,key:string}} Snapshot
 */

class TradeWindows {
    constructor(){
        /** @type {number|undefined} */
        this.timer = undefined;
        this.lastKey = "";
        this.retryAt = 0;
        this.failures = 0;
        this.generation = 0;
        this.busy = false;
        this.expanded = false;
        this.dismiss = (/** @type {Event} */ event) => {
            const details = this.box?.shadowRoot?.querySelector("details");
            if (!details?.open) return;
            if (event instanceof KeyboardEvent){
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                details.querySelector("summary")?.focus();
            }
            else if (event.target instanceof Node && this.box?.contains(event.target)) return;
            details.open = false;
            this.expanded = false;
        };
        /** @type {HTMLDivElement|null} */
        this.box = null;
    }

    start(){
        if (this.timer !== undefined) return;
        this.timer = window.setInterval(() => this.tick(), POLL_MS);
        window.addEventListener("pointerdown", this.dismiss, true);
        window.addEventListener("keydown", this.dismiss, true);
    }

    stop(){
        clearInterval(this.timer);
        this.timer = undefined;
        this.generation++;
        window.removeEventListener("pointerdown", this.dismiss, true);
        window.removeEventListener("keydown", this.dismiss, true);
        this.clear();
    }

    clear(){
        this.box?.remove();
        this.box = null;
        this.lastKey = "";
        this.expanded = false;
    }

    /** @param {string} text */
    static kr(text){
        const match = /([\d,.]+)/.exec(text.replace(/[~\s]/g, ""));
        return match ? Number(match[1].replace(/,/g, "")) || 0 : 0;
    }

    /** @param {Element} first @param {Element} second */
    static row(first, second){
        let parent = first.parentElement;
        while (parent && !parent.contains(second)) parent = parent.parentElement;
        return parent && parent !== document.body ? parent : null;
    }

    /** @return {Snapshot|null} */
    snapshot(){
        const sides = [...document.querySelectorAll(".trade-window .trade-side")].filter((side) => side.getClientRects().length);
        if (sides.length >= 2){
            const anchor = TradeWindows.row(sides[0], sides[1]);
            if (!anchor) return null;
            /** @param {Element} side */
            const items = (side) => [...side.querySelectorAll(".trade-offer-scroll .trade-inv-item")].map((node) => {
                const raw = node.getAttribute("data-index");
                const skin = raw !== null && /^\d+$/.test(raw) ? Number(raw) : -1;
                const src = node.querySelector("img")?.getAttribute("src") ?? "";
                /** @type {Entry} */
                const entry = { skin, count: TradeWindows.kr(node.querySelector(".trade-item-count")?.textContent ?? "1") || 1 };
                if (skin < 0) entry.path = /\/textures\/previews\/([^?#]+)/.exec(src)?.[1] ?? "";
                for (const [key, attr] of /** @type {const} */ ([["serial", "data-serial"], ["wear", "data-wear-float"], ["style", "data-style"]])){
                    const value = node.getAttribute(attr);
                    if (value !== null && value !== "" && Number.isFinite(Number(value))) entry[key] = Number(value);
                }
                return entry;
            });
            const give = items(sides[0]);
            const get = items(sides[1]);
            // .trade-est is the game's estimate, never currency added to the offer
            return { give, get, giveKr: 0, getKr: 0, anchor, key: JSON.stringify([give, get]) };
        }
        const lists = [document.getElementById("tradeList0"), document.getElementById("tradeList1")];
        if (!lists[0]?.getClientRects().length || !lists[1]?.getClientRects().length) return null;
        const anchor = TradeWindows.row(lists[0], lists[1]);
        if (!anchor) return null;
        /** @param {Element} list */
        const items = (list) => [...list.querySelectorAll("[id^='trd_']")].flatMap((node) => {
            const match = /^trd_\d+_(\d+)(?:_\d+)?$/.exec(node.id);
            return match ? [{ skin: Number(match[1]), count: TradeWindows.kr(node.querySelector(".tItemCnt")?.textContent ?? "1") || 1 }] : [];
        });
        /** @param {string} id */
        const kr = (id) => {
            const el = document.getElementById(id);
            return Math.max(0, el instanceof HTMLInputElement ? Number(el.value) || 0 : TradeWindows.kr(el?.textContent ?? "0"));
        };
        const give = items(lists[0]);
        const get = items(lists[1]);
        const giveKr = kr("offerVal0");
        const getKr = kr("offerVal1");
        return { give, get, giveKr, getKr, anchor, key: JSON.stringify([give, get, giveKr, getKr]) };
    }

    /** @param {Snapshot} snapshot @param {number} generation */
    current(snapshot, generation){
        if (this.timer === undefined || generation !== this.generation || document.pointerLockElement || document.hidden) return false;
        const now = this.snapshot();
        return now?.anchor === snapshot.anchor && now.key === snapshot.key;
    }

    async tick(){
        if (this.busy || this.timer === undefined || document.pointerLockElement || document.hidden) return;
        this.busy = true;
        const {generation} = this;
        try {
            const snapshot = this.snapshot();
            if (!snapshot){ this.clear(); return; }
            if (Date.now() < this.retryAt) return;
            if (snapshot.key === this.lastKey && this.box?.isConnected && this.box.nextElementSibling === snapshot.anchor) return;
            this.lastKey = snapshot.key;
            const empty = !snapshot.give.length && !snapshot.get.length && !snapshot.giveKr && !snapshot.getKr;
            this.render(snapshot, null, empty ? "Add items on both sides to compare estimated values." : "Updating estimates...");
            if (empty){ this.lastKey = snapshot.key; return; }
            const paths = [...snapshot.give, ...snapshot.get].filter((item) => item.skin < 0 && item.path).map((item) => /** @type {string} */ (item.path));
            const values = paths.length ? await marketApi.valuesByThumbnails(paths) : {};
            if (!this.current(snapshot, generation)) return;
            /** @param {Entry[]} items */
            const resolve = (items) => items.map(({ path, ...item }) => ({ ...item, skin: item.skin < 0 ? values[path ?? ""]?.skin ?? -1 : item.skin }));
            const give = resolve(snapshot.give);
            const get = resolve(snapshot.get);
            if ([...give, ...get].some((item) => item.skin < 0)){
                this.render(snapshot, null, "An item could not be identified. A complete comparison is unavailable.");
                return;
            }
            const result = await marketApi.analyzeStatus({ give, get, giveKr: snapshot.giveKr, getKr: snapshot.getKr });
            const verdict = result.data;
            if (verdict){
                this.failures = 0;
                this.retryAt = 0;
            }
            else {
                this.failures++;
                this.retryAt = result.status === 429 ? result.retryAt ?? Date.now() + 60_000 : Date.now() + Math.min(60_000, 5000 * 2 ** (this.failures - 1));
                this.lastKey = "";
            }
            if (!this.current(snapshot, generation)) return;
            const fallback = result.status === 429
                ? `Request limit reached. Estimates resume after ${new Date(this.retryAt).toLocaleTimeString()}.`
                : "Estimates unavailable. Retrying with a longer delay.";
            this.render(snapshot, verdict, fallback);
        }
        finally {
            this.busy = false;
        }
    }

    /** @param {Snapshot} snapshot @param {import("./types.js").TradeVerdict|null} verdict @param {string} fallback */
    render(snapshot, verdict, fallback){
        if (!this.box){
            this.box = document.createElement("div");
            this.box.className = "kuteTradeBox";
            this.box.style.cssText = "all:initial;display:block;box-sizing:border-box;width:100%;min-width:0;margin:0 0 10px;";
            this.box.attachShadow({ mode: "open" }).innerHTML = template;
        }
        const panel = this.box.shadowRoot?.querySelector(".panel");
        if (!panel) return;
        panel.className = `panel${snapshot.give.length || snapshot.get.length || snapshot.giveKr || snapshot.getKr ? " filled" : ""}`;
        this.expanded = panel.querySelector("details")?.open ?? this.expanded;
        let html = '<header><span class="brand">Kute trade insight</span>';
        if (!verdict) html += `</header><p class="empty" role="status">${esc(fallback)}</p>`;
        else {
            const oneSided = (!snapshot.give.length && !snapshot.giveKr) || (!snapshot.get.length && !snapshot.getKr);
            const partial = [...verdict.give.items, ...verdict.get.items].some((item) => item.unknown);
            const status = oneSided ? "Add items on both sides to compare" : TRADE_VERDICTS[verdict.verdict].detail;
            let callout = TRADE_VERDICTS[verdict.verdict].label;
            if (partial) callout = "Incomplete comparison";
            if (oneSided) callout = "Add both sides";
            html += `<span class="status ${oneSided ? "" : verdict.verdict}" role="status">${status}</span></header>`;
            /** @param {import("./types.js").TradeSide} side @param {string} label */
            const total = (side, label) => {
                const count = side.items.reduce((sum, item) => sum + item.count, 0);
                const incomplete = side.items.some((item) => item.unknown);
                return `<div class="side"><span class="label">${label}</span><strong>${formatKr(side.value)}${incomplete ? "+" : ""} <span class="unit">KR</span></strong><span class="meta">${count} ${count === 1 ? "item" : "items"}${side.kr ? ` + ${formatKr(side.kr)} KR` : ""} &middot; ${incomplete ? "Partial estimate" : "Estimated value"}</span></div>`;
            };
            const difference = oneSided || partial ? '<strong>&ndash;</strong><span class="meta">Incomplete comparison</span>' : `<strong>${verdict.difference > 0 ? "+" : ""}${formatKr(verdict.difference)} <span class="unit">KR</span></strong><span class="meta">${esc(formatPercent(verdict.differenceShare))} of the larger side</span>`;
            html += `<div class="comparison">${total(verdict.give, "You give")}<div class="difference ${oneSided || partial ? "" : verdict.verdict}"><span class="verdict" role="status">${callout}</span>${difference}</div>${total(verdict.get, "You receive")}</div>`;
            /** @param {import("./types.js").TradeSide} side @param {string} label */
            const breakdown = (side, label) => `<div><h3>${label}</h3>${side.items.map((item) => `<div class="line"><span class="name">${item.count > 1 ? `${item.count} &times; ` : ""}${esc(item.name)}${item.serial !== undefined ? ` #${item.serial}` : ""}${item.wear !== undefined ? ` &middot; wear ${item.wear.toFixed(4)}` : ""}${item.unknown ? "" : `<span class="grade" title="Activity grade ${item.grade}" style="background:${GRADE_COLORS[item.grade]}">${item.grade}</span>`}</span><span class="amount">${item.unknown ? "Unvalued" : `${formatKr(item.lineValue)} KR`}</span></div>`).join("")}${side.kr ? `<div class="line"><span>Added KR</span><span>${formatKr(side.kr)} KR</span></div>` : ""}${!side.items.length && !side.kr ? '<span class="meta">No items added</span>' : ""}</div>`;
            html += `<details${this.expanded ? " open" : ""}><summary><span class="show">Item breakdown &amp; evidence</span><span class="hide">Hide item breakdown &amp; evidence</span></summary><div class="detailBody"><div class="breakdown">${breakdown(verdict.give, "You give")}${breakdown(verdict.get, "You receive")}</div><ul class="notes"><li>Estimates describe market data, not guaranteed sale prices. Activity grades do not guarantee a selling time.</li>${verdict.drivers.filter((driver) => !driver.startsWith("Liquidity adjustments")).map((driver) => `<li>${esc(driver)}</li>`).join("")}</ul></div></details>`;
        }
        panel.innerHTML = html;
        // the game lays out the inventories as a flex row; our panel must be its sibling
        if (this.box.nextElementSibling !== snapshot.anchor) snapshot.anchor.before(this.box);
    }
}

const trade = new TradeWindows();
export default trade;
