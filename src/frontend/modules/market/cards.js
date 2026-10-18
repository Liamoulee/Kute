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
.${LINE_CLASS}{pointer-events:none;white-space:nowrap}
.${LINE_CLASS}.kuteFloating{position:absolute;left:6px;bottom:6px;z-index:3;background:rgba(0,0,0,.72);color:#fff;padding:2px 7px;border-radius:5px;font-size:12px;font-weight:700}
.${LINE_CLASS} .kuteMark{color:#f5479b;font-weight:900}
.${LINE_CLASS} .kuteGrade{display:inline-block;min-width:1.1em;text-align:center;border-radius:3px;padding:0 .3em;margin-left:.35em;color:#111;font-size:.8em;vertical-align:middle}
.${LINE_CLASS} .kuteDelta{margin-left:.35em;font-size:.85em}
.${LINE_CLASS} .kuteDelta.kuteDeal{color:#5ce05a}
.${LINE_CLASS} .kuteDelta.kuteOver{color:#f44336}
`;

class Cards {
    constructor(){
        /** @type {number|undefined} */
        this.timer = undefined;
        this.busy = false;
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
        for (const line of document.querySelectorAll(`.${LINE_CLASS}`)) line.remove();
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
        line.title = `Kute fair value ${formatKr(value.fair)} kr, ${value.confidence} % confidence, liquidity ${value.grade}` + (ask !== null ? `, this ask ${formatPercent(ask / value.fair - 1)} against it` : "");
        if (estimate) estimate.after(line);
        else card.append(line);
    }
}

const cards = new Cards();
export default cards;
