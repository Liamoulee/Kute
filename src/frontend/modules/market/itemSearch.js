import marketApi from "./api.js";
import { esc, identity, money } from "./presentation.js";

/** @typedef {{skin:number,name:string,thumbnail?:string|null,rarity?:number,fair:number}} SearchItem */

/** @param {string} id @param {string} context @param {string} label @param {string} [value] */
export const itemSearch = (id, context, label, value = "") => `<div class="itemSearch"><input id="${id}" data-item-search="${context}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}Options" aria-label="${esc(label)}${context === "give" ? " to your side" : ""}${context === "get" ? " to their side" : ""}" placeholder="${esc(label)}" autocomplete="off" value="${esc(value)}"><div class="suggestions" id="${id}List" hidden></div></div>`;

export default class ItemSearch {
    /** @param {ShadowRoot} root @param {AbortSignal} signal @param {(item:SearchItem,context:string)=>void} select @param {(q:string,context:string)=>void} browse @param {()=>SearchItem[]} holdings */
    constructor(root, signal, select, browse, holdings){
        this.root = root;
        this.select = select;
        this.browse = browse;
        this.holdings = holdings;
        /** @type {HTMLInputElement|null} */
        this.input = null;
        /** @type {HTMLElement|null} */
        this.list = null;
        /** @type {SearchItem[]} */
        this.items = [];
        this.active = -1;
        this.sequence = 0;
        this.timer = 0;
        root.addEventListener("input", (event) => {
            if (event.target instanceof HTMLInputElement && event.target.dataset.itemSearch) this.search(event.target);
        }, { signal });
        root.addEventListener("focusin", (event) => {
            if (event.target !== this.input && !(event.target instanceof Element && this.list?.contains(event.target))) this.dismiss();
        }, { signal });
        root.addEventListener("pointerdown", (event) => {
            if (!(event.target instanceof Element)) return;
            if (this.list?.contains(event.target)) event.preventDefault();
            else if (event.target !== this.input) this.dismiss();
        }, { signal });
        root.addEventListener("click", (event) => {
            const button = event.target instanceof Element ? event.target.closest("[data-suggestion],[data-search-all]") : null;
            if (!(button instanceof HTMLElement) || !this.list?.contains(button)) return;
            if (button.dataset.suggestion !== undefined) this.choose(Number(button.dataset.suggestion));
            else {
                const q = this.input?.value.trim() ?? "";
                const context = this.input?.dataset.itemSearch ?? "global";
                this.dismiss();
                this.browse(q, context);
            }
        }, { signal });
        signal.addEventListener("abort", () => this.dismiss(), { once: true });
    }

    dismiss(){
        clearTimeout(this.timer);
        this.sequence++;
        if (this.list) this.list.hidden = true;
        this.input?.setAttribute("aria-expanded", "false");
        this.input?.removeAttribute("aria-activedescendant");
        this.input = null;
        this.list = null;
        this.items = [];
        this.active = -1;
    }

    /** @param {HTMLInputElement} input */
    search(input){
        this.dismiss();
        const q = input.value.trim();
        if (!q) return;
        const list = /** @type {HTMLElement|null} */ (this.root.getElementById(`${input.id}List`));
        if (!list) return;
        this.input = input;
        this.list = list;
        list.hidden = false;
        list.innerHTML = `<div class="suggestionStatus" role="status">Searching items...</div><div id="${input.id}Options" role="listbox" aria-label="Matching items" aria-busy="true"></div>`;
        input.setAttribute("aria-expanded", "true");
        const { sequence } = this;
        this.timer = window.setTimeout(async() => {
            /** @type {SearchItem[]|null} */
            let items = null;
            try {
                if (input.dataset.itemSearch === "holdings") items = this.holdings().filter((i) => i.name.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
                else {
                    /** @type {import("./types.js").SearchReply|null} */
                    const reply = await marketApi.cached(`/market/search?q=${encodeURIComponent(q)}&sort=volume&page=1`, 60_000);
                    items = reply?.items ?? null;
                }
            }
            catch { items = null; }
            if (sequence !== this.sequence || !input.isConnected || input.value.trim() !== q) return;
            this.items = items?.slice(0, 8) ?? [];
            const context = input.dataset.itemSearch;
            const label = context === "holdings" ? "Your holdings" : "All items";
            const action = context === "give" || context === "get" ? "Add" : "Open";
            list.innerHTML = `<div class="suggestionHeading">${label}<span>${action} an item</span></div><div id="${input.id}Options" role="listbox" aria-label="${label}">${this.items.map((item, index) => `<button type="button" role="option" tabindex="-1" aria-selected="false" id="${input.id}Option${index}" data-suggestion="${index}">${identity(item)}<span class="suggestionValue">${money(item.fair)}<small>KR est.</small></span></button>`).join("")}</div>${!items || !items.length ? `<div class="suggestionStatus" role="status">${items ? "No matching items" : "Search unavailable. Try typing again."}</div>` : ""}${context === "global" || context === "discover" ? '<button type="button" class="searchAll" data-search-all>View search results &#8594;</button>' : ""}`;
        }, 250);
    }

    /** @param {number} index */
    choose(index){
        const item = this.items[index];
        const context = this.input?.dataset.itemSearch;
        if (!item || !context) return;
        this.dismiss();
        this.select(item, context);
    }

    /** @param {KeyboardEvent} event */
    key(event){
        if (event.isComposing) return false;
        const input = this.root.activeElement;
        if (!(input instanceof HTMLInputElement) || !input.dataset.itemSearch) return false;
        if (event.key === "Tab"){ this.dismiss(); return false; }
        if (event.key === "Escape" && this.input){ this.dismiss(); event.preventDefault(); return true; }
        if (event.key === "Enter" && this.active >= 0){ this.choose(this.active); event.preventDefault(); return true; }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
        event.preventDefault();
        if (this.input !== input){ this.search(input); return true; }
        if (!this.items.length) return true;
        let next = this.active + (event.key === "ArrowDown" ? 1 : -1);
        if (this.active < 0 && event.key === "ArrowUp") next = this.items.length - 1;
        this.active = (next + this.items.length) % this.items.length;
        this.list?.querySelectorAll("[data-suggestion]").forEach((option, index) => option.setAttribute("aria-selected", String(index === this.active)));
        const id = `${input.id}Option${this.active}`;
        input.setAttribute("aria-activedescendant", id);
        this.root.getElementById(id)?.scrollIntoView({ block: "nearest" });
        return true;
    }
}
