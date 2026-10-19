import { kute } from "../../client.js";
import marketApi from "./api.js";
import { GRADE_COLORS, formatKr, formatPercent } from "./types.js";

// one line under every market card: our value, the grade and how the ask compares. the game's card
// shows only a preview image and an ask, the image path names the skin. the menu is polled at a slow
// rate, never a body wide observer, and nothing runs while the pointer is locked

const POLL_MS = 1500;
const MARK = "data-kute-market";
const LINE_CLASS = "kuteMarketLine";
const STYLE_ID = "kuteMarketCardStyle";
const CARD_SELECTOR = ".market-card, .market-item-card";
// the line borrows krunker's estimate badge classes (same font, box and position in the badge stack), so only
// the grade square and the delta are ours
const CSS = `
.market-card,.market-item-card{position:relative}
.${LINE_CLASS}{display:inline-flex!important;align-items:center;gap:.35em;white-space:nowrap;cursor:pointer;pointer-events:auto}
.${LINE_CLASS}:hover{filter:brightness(1.25)}
.${LINE_CLASS}.kuteFloating{position:absolute;left:6px;bottom:6px;z-index:3;background:rgba(0,0,0,.72);color:#fff;padding:2px 7px;border-radius:5px;font-size:12px;font-weight:700}
.${LINE_CLASS} .kuteMark{color:#f5479b;font-weight:900}
.${LINE_CLASS} .kuteGrade{display:inline-flex;align-items:center;justify-content:center;min-width:1.4em;height:1.4em;border-radius:3px;padding:0 .25em;color:#111;font-size:.75em;line-height:1}
.${LINE_CLASS} .kuteDelta{font-size:.85em}
.${LINE_CLASS} .kuteDelta.kuteDeal{color:#5ce05a}
.${LINE_CLASS} .kuteDelta.kuteOver{color:#f44336}
.kuteDetailBtn .kuteMark{color:#f5479b;font-weight:900;margin-right:2px}
`;
const DETAIL_SELECTOR = ".item-detail-container, .items-detail-root";
const DETAIL_BTN_CLASS = "kuteDetailBtn";

/** a pick older than this cannot be the item a detail view opened for */
const PICK_MS = 5000;

class Cards {
    constructor(){
        /** @type {number|undefined} */
        this.timer = undefined;
        this.busy = false;
        /** @type {{skin:number,name:string,at:number}|null} */
        this.pick = null;
        // trade lists carry the skin in their ids, their detail view only shows a name and a background image
        this.onPick = (/** @type {Event} */ event) => {
            if (document.pointerLockElement || !(event.target instanceof Element)) return;
            const node = event.target.closest("[id^='trd_'], .trade-inv-item[data-index]");
            if (!node) return;
            const match = /^trd_(?:sel_|inv_)?\d+_(\d+)/.exec(node.id);
            const raw = match ? match[1] : node.getAttribute("data-index");
            if (raw === null || !/^\d+$/.test(raw)) return;
            const name = node.querySelector(".tItemN")?.textContent?.trim() ?? "";
            this.pick = { skin: Number(raw), name, at: Date.now() };
        };
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
        document.addEventListener("pointerdown", this.onPick, true);
    }

    stop(){
        clearInterval(this.timer);
        this.timer = undefined;
        document.removeEventListener("pointerdown", this.onPick, true);
        this.pick = null;
        for (const line of document.querySelectorAll(`.${LINE_CLASS}, .${DETAIL_BTN_CLASS}`)) line.remove();
        for (const card of document.querySelectorAll(`[${MARK}]`)) card.removeAttribute(MARK);
    }

    /**
     * @param {string} src
     * @return {string|null} the path after textures/previews/
     */
    static thumbPath(src){
        const match = /\/textures\/previews\/([^?#]+)/.exec(src);
        return match ? match[1] : null;
    }

    /**
     * @param {Element} card
     * @return {number|null} the ask the card shows, from the first kr figure in it
     */
    static askOf(card){
        // the browse grid prints the ask in .inline-price, other views are searched for the first kr figure
        const price = card.querySelector(".inline-price");
        if (price){
            const value = Number((price.textContent ?? "").replace(/[^\d.]/g, ""));
            return Number.isFinite(value) && value > 0 ? value : null;
        }
        for (const node of card.querySelectorAll("span, div")){
            if (node.classList.contains(LINE_CLASS) || node.children.length) continue;
            const text = node.textContent?.trim() ?? "";
            if (/^~/.test(text)) continue;
            const match = /^([\d,.]+)\s*KR$/i.exec(text) ?? /^([\d,.]+)$/.exec(text);
            if (match && node.closest(".estimate-badge") === null){
                const value = Number(match[1].replace(/,/g, ""));
                if (Number.isFinite(value) && value > 0) return value;
            }
        }
        return null;
    }

    async tick(){
        if (this.busy || document.pointerLockElement) return;
        const detail = document.querySelector(DETAIL_SELECTOR);
        // the catalog view stays mounted and swaps its item, its label tells them apart
        const label = detail?.getAttribute("aria-label") ?? "1";
        if (detail && detail.getAttribute(MARK) !== label){
            detail.setAttribute(MARK, label);
            detail.querySelector(`.${DETAIL_BTN_CLASS}`)?.remove();
            await this.detailButton(detail, label);
        }
        const cards = [...document.querySelectorAll(CARD_SELECTOR)].filter((card) => !card.hasAttribute(MARK));
        if (!cards.length) return;
        this.busy = true;
        try {
            /** @type {Map<string, Element[]>} */
            const byPath = new Map();
            for (const card of cards){
                card.setAttribute(MARK, "1");
                const img = card.querySelector("img");
                const path = img instanceof HTMLImageElement ? Cards.thumbPath(img.currentSrc || img.src) : null;
                if (!path) continue;
                const list = byPath.get(path) ?? [];
                list.push(card);
                byPath.set(path, list);
            }
            if (!byPath.size) return;
            const values = await marketApi.valuesByThumbnails([...byPath.keys()]);
            for (const [path, list] of byPath){
                const value = values[path];
                for (const card of list){
                    // the card may have been re-rendered while we waited
                    if (!card.isConnected) continue;
                    this.draw(card, value ?? null);
                }
            }
        }
        finally {
            this.busy = false;
        }
    }

    /**
     * the skin a detail view shows: the item just clicked in a trade list, its preview image, or an exact name
     *
     * @param {Element} detail
     * @param {string} label the view's item name
     * @return {Promise<import("./types.js").SkinValue|null>}
     */
    async detailValue(detail, label){
        const { pick } = this;
        if (pick && Date.now() - pick.at < PICK_MS && (!pick.name || pick.name === label)){
            const values = await marketApi.values([pick.skin]);
            if (values[pick.skin]) return values[pick.skin];
        }
        const img = detail.querySelector(".market-card img, .items-detail-preview-panel img, img");
        let src = img instanceof HTMLImageElement ? img.currentSrc || img.src : "";
        // the catalog page paints its preview as a css background
        if (!src) src = /url\("?([^")]+)"?\)/.exec(detail.querySelector(".items-detail-image")?.getAttribute("style") ?? "")?.[1] ?? "";
        const path = Cards.thumbPath(src);
        if (path){
            const values = await marketApi.valuesByThumbnails([path]);
            if (values[path]) return values[path];
        }
        if (!label || label === "1") return null;
        /** @type {import("./types.js").SearchReply|null} */
        const reply = await marketApi.cached(`/market/search?q=${encodeURIComponent(label)}&sort=volume&page=1`, 60_000);
        // names repeat across skins (several Cherry Blossoms), only a unique exact match is safe
        const exact = reply?.items.filter((item) => item.name.toLowerCase() === label.toLowerCase()) ?? [];
        return exact.length === 1 ? exact[0] : null;
    }

    /**
     * a "Kute Market" button in krunker's item detail header, styled like its own header buttons
     *
     * @param {Element} detail
     * @param {string} label
     */
    async detailButton(detail, label){
        // the market's "Listing Details" (next to Item Info) and the catalog's item page (header actions)
        const actions = detail.querySelector(".full-details-container, .items-detail-header-actions");
        if (!actions) return;
        const button = document.createElement("button");
        button.type = "button";
        const sibling = actions.querySelector("button");
        button.className = `${sibling?.className ?? ""} ${DETAIL_BTN_CLASS}`.trim();
        const icon = sibling?.querySelector("i")?.className ?? "material-icons";
        button.innerHTML = `<i class="${icon}">candlestick_chart</i> <span>Kute Market</span>`;
        button.title = "K value, liquidity, price history, depth and owners in Kute Market";
        actions.append(button);
        const value = await this.detailValue(detail, label);
        // the view may have switched items while we waited
        if (!value || detail.getAttribute(MARK) !== label){
            button.remove();
            return;
        }
        const text = button.querySelector("span");
        if (text) text.textContent = `Kute Market · K ${formatKr(value.fair)} ${value.grade}`;
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            kute.market?.open("item", value.skin);
        });
    }

    /**
     * @param {Element} card
     * @param {import("./types.js").SkinValue|null} value
     */
    draw(card, value){
        card.querySelector(`.${LINE_CLASS}`)?.remove();
        if (!value) return;
        const line = document.createElement("div");
        const estimate = card.querySelector(".estimate-badge");
        line.className = estimate ? `${estimate.className} ${LINE_CLASS}` : `${LINE_CLASS} kuteFloating`;
        const ask = Cards.askOf(card);
        let delta = "";
        if (ask !== null && value.fair > 0){
            const share = ask / value.fair - 1;
            let cls = "";
            if (share <= -0.1 && value.confidence >= 40) cls = "kuteDeal";
            else if (share >= 0.25) cls = "kuteOver";
            const percent = Math.round(Math.abs(share) * 100);
            delta = `<span class="kuteDelta ${cls}">${share < 0 ? "−" : "+"}${percent}%</span>`;
        }
        line.innerHTML = `<span class="kuteMark">K</span> ${formatKr(value.fair)}<span class="kuteGrade" style="background:${GRADE_COLORS[value.grade]}">${value.grade}</span>${delta}`;
        line.title = `Kute fair value ${formatKr(value.fair)} kr, evidence score ${value.confidence}/100, public-market activity grade ${value.grade}`
            + (value.privateTrading?.trades7d ? `, ${value.privateTrading.trades7d} reported private trades this week` : "")
            + (value.exchange?.status === "applied" ? ", includes private exchange evidence" : "")
            + (ask !== null ? `, this ask ${formatPercent(ask / value.fair - 1)} against it` : "") + ". Click for the item in Kute Market";
        line.addEventListener("click", (event) => {
            // the card itself opens krunker's detail view on click
            event.stopPropagation();
            event.preventDefault();
            kute.market?.open("item", value.skin);
        });
        if (estimate) estimate.after(line);
        else card.append(line);
    }
}

const cards = new Cards();
export default cards;
