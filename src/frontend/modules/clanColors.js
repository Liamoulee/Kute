import { kute } from "../client.js";
import playerLists, { clanTag } from "./playerLists.js";
import api from "./api.js";

// a tag keeps Krunker's font, size and spacing, only its paint changes: everything else in a style is dropped
const PAINT_PROPERTIES = new Set([
    "background",
    "background-image",
    "background-color",
    "background-clip",
    "-webkit-background-clip",
    "background-size",
    "background-position",
    "color",
    "-webkit-text-fill-color",
    "-webkit-text-stroke",
    "text-shadow",
    "text-decoration",
    "filter",
    "opacity",
    "animation",
]);

/**
 * @param {string} css
 * @return {string} The declarations of css whose property is about paint, nothing about layout or type
 */
function paintOnly(css){
    return css
        .split(";")
        .map((declaration) => declaration.trim())
        .filter((declaration) => {
            const property = declaration.split(":")[0]?.trim().toLowerCase();
            return Boolean(property) && declaration.includes(":") && PAINT_PROPERTIES.has(property);
        })
        .join(";");
}

/** @typedef {import("./playerLists.js").Row} Row */

class ClanColors {
    constructor(){
        /** @type {Record<string, string>} clan tag -> CSS text */
        this.styles = {};
        /** @type {Record<string, string>} what the server sent, kept for switching back on without a fetch */
        this.fetched = {};
        this.watching = false;
        /** @type {(row: Row) => void} */
        this.decorator = (row) => this.restyle(row);
        kute.settings.toggleClanColors = (enabled) => this.toggle(enabled);
        this.load();
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        if (enabled){
            if (Object.keys(this.fetched).length > 0) this.apply(this.fetched);
            else this.load();
            return;
        }
        playerLists.remove(this.decorator);
        this.watching = false;
        this.styles = {};
        // back to what Krunker had written into the span
        for (const span of document.querySelectorAll("[data-kute-clan]")){
            span.setAttribute("style", span.getAttribute("data-kute-style") ?? "");
            span.removeAttribute("data-kute-clan");
            span.removeAttribute("data-kute-style");
        }
    }

    /**
     * Fetches the styles once and starts watching the lists.
     */
    async load(){
        // null without a server: no styled tags then
        const meta = await api.request("/meta");
        if (typeof meta?.clanTagColors === "object" && meta.clanTagColors !== null) this.fetched = meta.clanTagColors;
        if (kute.settings.data.clanColors !== false) this.apply(this.fetched);
    }

    /**
     * Uses a set of styles (also the entry point for trying styles out by hand).
     *
     * @param {unknown} styles Clan tag -> CSS text
     */
    apply(styles){
        if (typeof styles !== "object" || styles === null) return;
        this.styles = {};
        for (const [tag, css] of Object.entries(styles)){
            if (typeof css !== "string" || tag.length === 0 || tag.length > 16) continue;
            const paint = paintOnly(css);
            if (paint) this.styles[tag] = paint;
        }
        if (Object.keys(this.styles).length === 0) return;

        if (this.watching) playerLists.refresh();
        else playerLists.add(this.decorator);
        this.watching = true;
    }

    /**
     * @param {Row} row
     */
    restyle(row){
        const clan = clanTag(row.element);
        if (!clan) return;
        const css = this.styles[clan.tag];
        if (!css || clan.span.getAttribute("data-kute-clan") === clan.tag) return;
        if (!clan.span.hasAttribute("data-kute-style")) clan.span.setAttribute("data-kute-style", clan.span.getAttribute("style") ?? "");
        clan.span.setAttribute("style", css);
        clan.span.setAttribute("data-kute-clan", clan.tag);
    }
}

const clanColors = new ClanColors();
kute.clanColors = clanColors;
export default clanColors;
