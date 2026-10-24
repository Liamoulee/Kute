import marketApi from "./api.js";
import { formatKr, formatPercent } from "./types.js";
import { esc, TRADE_VERDICTS, tradeBreakdown, tradeNotes, verdictOf } from "./presentation.js";
import template from "../../components/marketOffer.html";

const POLL_MS = 1200;
// /market/analyze allows 20 a minute per session and the trade window shares that budget
const SPACING_MS = 3500;
const REFRESH_MS = 10 * 60 * 1000;
const KEEP = 200;

/**
 * @typedef {import("./types.js").TradeItem & {path?:string}} Entry
 * @typedef {{give:Entry[],get:Entry[],giveKr:number,getKr:number,unvalued:string[],open:boolean[],key:string}} Offer
 * @typedef {{verdict:import("./types.js").TradeVerdict|null,message:string,at:number}} Result
 */

class TradeOffers {
    constructor(){
        /** @type {number|undefined} */
        this.timer = undefined;
        this.busy = false;
        this.nextAt = 0;
        this.failures = 0;
        this.waiting = "";
        this.generation = 0;
        /** @type {Map<string, Result>} */
        this.results = new Map();
        /** @type {WeakMap<Element, HTMLDivElement>} */
        this.boxes = new WeakMap();
        /** @type {WeakMap<HTMLDivElement, string>} */
        this.shown = new WeakMap();
    }

    start(){
        if (this.timer !== undefined) return;
        this.timer = window.setInterval(() => this.tick(), POLL_MS);
    }

    stop(){
        clearInterval(this.timer);
        this.timer = undefined;
        this.generation++;
        for (const box of document.querySelectorAll(".kuteOfferBox")) box.remove();
        this.boxes = new WeakMap();
    }

    /**
     * the first column is always the player's own side, in incoming, outgoing and history alike
     *
     * @param {Element} holder
     * @return {Offer|null}
     */
    static read(holder){
        const contents = holder.querySelectorAll(":scope > .offer-items-row > .offer-contents");
        if (contents.length !== 2) return null;
        /** @type {Set<string>} */
        const unvalued = new Set();
        /** @type {boolean[]} */
        const open = [];
        /** @param {Element} content */
        const side = (content) => {
            const items = [...content.querySelectorAll(".trade-item:not(.trade-item-empty)")].map((node) => {
                const raw = node.getAttribute("data-index");
                const skin = raw !== null && /^\d+$/.test(raw) ? Number(raw) : -1;
                /** @type {Entry} */
                const entry = { skin, count: 1 };
                if (skin < 0) entry.path = /\/textures\/previews\/([^?#]+)/.exec(node.querySelector("img")?.getAttribute("src") ?? "")?.[1] ?? "";
                for (const [key, attr] of /** @type {const} */ ([["serial", "data-serial"], ["wear", "data-wear-float"], ["style", "data-style"]])){
                    const value = node.getAttribute(attr);
                    if (value !== null && value !== "" && Number.isFinite(Number(value))) entry[key] = Number(value);
                }
                return entry;
            });
            let kr = 0;
            let other = false;
            // "+1,234 KR" from toLocaleString, so the separator follows the player's locale
            for (const node of content.querySelectorAll(".trade-currency-item")){
                const match = /^\+?\s*(.*?)\s*([A-Za-z]+)$/.exec(node.textContent?.trim() ?? "");
                const digits = match?.[1].replace(/\D/g, "") ?? "";
                if (match?.[2] === "KR" && digits) kr += Number(digits);
                else {
                    unvalued.add(match?.[2] ?? "?");
                    other = true;
                }
            }
            open.push(other);
            return { items, kr };
        };
        const give = side(contents[0]);
        const get = side(contents[1]);
        const offer = { give: give.items, get: get.items, giveKr: give.kr, getKr: get.kr, unvalued: [...unvalued].sort(), open };
        return { ...offer, key: JSON.stringify(offer) };
    }

    /** @param {Element} holder */
    box(holder){
        let box = this.boxes.get(holder);
        if (!box?.isConnected){
            box = document.createElement("div");
            box.className = "kuteOfferBox";
            box.style.cssText = "all:initial;display:block;box-sizing:border-box;width:100%;min-width:0;";
            box.attachShadow({ mode: "open" }).innerHTML = template;
            // svelte inserts before its own anchors, so the end of the holder stays ours
            holder.append(box);
            this.boxes.set(holder, box);
        }
        return box;
    }

    tick(){
        if (this.timer === undefined || document.pointerLockElement || document.hidden) return;
        const holders = document.querySelectorAll(".offer-holder");
        if (!holders.length) return;
        const now = Date.now();
        /** @type {Offer|null} */
        let pending = null;
        for (const holder of holders){
            if (!holder.getClientRects().length) continue;
            const offer = TradeOffers.read(holder);
            if (!offer) continue;
            const result = this.results.get(offer.key) ?? null;
            const box = this.box(holder);
            const waiting = this.waiting && now < this.nextAt ? this.waiting : "Updating estimates...";
            const state = `${offer.key}|${result?.at ?? waiting}`;
            if (this.shown.get(box) !== state){
                this.shown.set(box, state);
                TradeOffers.render(box, offer, result, waiting);
            }
            if (pending || (result && now - result.at < REFRESH_MS)) continue;
            const rect = holder.getBoundingClientRect();
            if (rect.bottom > 0 && rect.top < window.innerHeight) pending = offer;
        }
        if (pending && !this.busy && now >= this.nextAt) this.analyze(pending);
    }

    /** @param {Offer} offer */
    async analyze(offer){
        this.busy = true;
        const {generation} = this;
        try {
            const result = await this.evaluate(offer);
            if (generation !== this.generation || !result) return;
            this.results.delete(offer.key);
            this.results.set(offer.key, result);
            if (this.results.size > KEEP) this.results.delete(/** @type {string} */ (this.results.keys().next().value));
        }
        finally {
            this.busy = false;
        }
        this.tick();
    }

    /** @param {Offer} offer @return {Promise<Result|null>} */
    async evaluate(offer){
        if (!offer.give.length && !offer.get.length && !offer.giveKr && !offer.getKr) return { verdict: null, message: "This offer has nothing to compare.", at: Date.now() };
        const paths = [...offer.give, ...offer.get].filter((item) => item.skin < 0 && item.path).map((item) => /** @type {string} */ (item.path));
        const values = paths.length ? await marketApi.valuesByThumbnails(paths) : {};
        /** @param {Entry[]} items */
        const resolve = (items) => items.map(({ path, ...item }) => ({ ...item, skin: item.skin < 0 ? values[path ?? ""]?.skin ?? -1 : item.skin }));
        const give = resolve(offer.give);
        const get = resolve(offer.get);
        if ([...give, ...get].some((item) => item.skin < 0)) return { verdict: null, message: "An item could not be identified. A complete comparison is unavailable.", at: Date.now() };
        this.nextAt = Date.now() + SPACING_MS;
        const reply = await marketApi.analyzeStatus({ give, get, giveKr: offer.giveKr, getKr: offer.getKr });
        if (reply.data){
            this.failures = 0;
            this.waiting = "";
            return { verdict: reply.data, message: "", at: Date.now() };
        }
        this.failures++;
        this.nextAt = reply.status === 429 ? reply.retryAt ?? Date.now() + 60_000 : Date.now() + Math.min(60_000, 5000 * 2 ** (this.failures - 1));
        this.waiting = reply.status === 429
            ? `Request limit reached. Estimates resume after ${new Date(this.nextAt).toLocaleTimeString()}.`
            : "Estimates unavailable. Retrying with a longer delay.";
        return null;
    }

    /** @param {HTMLDivElement} box @param {Offer} offer @param {Result|null} result @param {string} waiting */
    static render(box, offer, result, waiting){
        const panel = box.shadowRoot?.querySelector(".panel");
        if (!panel) return;
        const open = panel.querySelector("details")?.open ?? false;
        const verdict = result?.verdict;
        if (!verdict){
            panel.innerHTML = `<div class="row"><span class="brand">Kute</span><span class="empty" role="status">${esc(result?.message || waiting)}</span></div>`;
            return;
        }
        const oneSided = (!offer.give.length && !offer.giveKr) || (!offer.get.length && !offer.getKr);
        const partial = offer.unvalued.length > 0 || [...verdict.give.items, ...verdict.get.items].some((item) => item.unknown);
        const kind = verdictOf(verdict.verdict);
        let callout = TRADE_VERDICTS[kind].label;
        if (partial) callout = "Incomplete comparison";
        if (oneSided) callout = "One-sided offer";
        const tone = oneSided || partial ? "" : kind;
        /** @param {import("./types.js").TradeSide} side @param {boolean} more */
        const total = (side, more) => `<b>${formatKr(side.value)}${more || side.items.some((item) => item.unknown) ? "+" : ""}</b> KR`;
        const difference = oneSided || partial ? "" : `<span class="diff ${tone}">${verdict.difference > 0 ? "+" : ""}${formatKr(verdict.difference)} KR <small>${esc(formatPercent(verdict.differenceShare))} of the larger side</small></span>`;
        const notes = offer.unvalued.length ? [`${offer.unvalued.join(", ")} in this offer ${offer.unvalued.length === 1 ? "has" : "have"} no market estimate`] : [];
        panel.innerHTML = `<div class="row"><span class="brand">Kute</span><span class="verdict ${tone}" role="status">${callout}</span><span class="sides">You give ${total(verdict.give, offer.open[0])} &middot; You receive ${total(verdict.get, offer.open[1])}</span>${difference}</div>`
            + `<details${open ? " open" : ""}><summary><span class="show">Item breakdown &amp; evidence</span><span class="hide">Hide item breakdown &amp; evidence</span></summary><div class="breakdown">${tradeBreakdown(verdict.give, "You give")}${tradeBreakdown(verdict.get, "You receive")}</div>${tradeNotes(verdict, notes)}</details>`;
    }
}

const offers = new TradeOffers();
export default offers;
