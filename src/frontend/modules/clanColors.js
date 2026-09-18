import { kute } from "../client.js";

// The "Show clan colors" setting: styled clan tags in the player lists. The styles come from the Kute server once per page load
// (GET /api/meta, `clanTagColors`: clan tag -> CSS text), so a clan can get its colors without a client update.
//
// Krunker renders every list entry as NAME<span style="color:..."> [clan]</span>. Only such a span, a direct
// child of a name element in one of the four lists, with exactly "[tag]" as its text, gets restyled.
// Nothing else on the page is touched.

const META_URL = "https://kute.lol/api/meta";

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

// the alt list, the in-game scoreboard, the top right leaderboard and the end screen
const LISTS = ["#playerListH", "#ingameTable", "#leaderboardHolder", "#endTable"];
const TAG_SPANS = ".pListName > span, .newLeaderNameM > span, .leaderNameM > span, .endTableN > span";

class ClanColors {
    constructor(){
        /** @type {Record<string, string>} clan tag -> CSS text */
        this.styles = {};
        /** @type {Record<string, string>} what the server sent, kept for switching back on without a fetch */
        this.fetched = {};
        /** @type {Map<Element, MutationObserver>} */
        this.observers = new Map();
        this.timer = 0;
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
        clearInterval(this.timer);
        this.timer = 0;
        for (const observer of this.observers.values()) observer.disconnect();
        this.observers.clear();
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
        try {
            const response = await fetch(META_URL, { cache: "default" });
            if (!response.ok) return;
            const meta = await response.json();
            if (typeof meta?.clanTagColors === "object" && meta.clanTagColors !== null) this.fetched = meta.clanTagColors;
            if (kute.settings.data.clanColors !== false) this.apply(this.fetched);
        }
        catch {
            // no server, no styled tags
        }
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

        // the lists come and go with the match state (the alt list only exists while alt is held), so the ones
        // that exist get looked up and observed twice a second: four querySelector calls
        this.watch();
        if (!this.timer) this.timer = setInterval(() => this.watch(), 500);
    }

    /**
     * Restyles the tags in every list that exists and observes it for the next rebuild.
     */
    watch(){
        for (const selector of LISTS){
            const list = document.querySelector(selector);
            if (!list) continue;
            this.restyle(list);
            if (this.observers.has(list)) continue;
            const observer = new MutationObserver(() => this.restyle(list));
            observer.observe(list, { childList: true, subtree: true });
            this.observers.set(list, observer);
        }
    }

    /**
     * @param {Element} list
     */
    restyle(list){
        for (const span of list.querySelectorAll(TAG_SPANS)){
            const text = span.textContent ?? "";
            const match = /^\s*\[(.+)\]\s*$/.exec(text);
            const css = match ? this.styles[match[1]] : undefined;
            if (!css || span.getAttribute("data-kute-clan") === match?.[1]) continue;
            if (!span.hasAttribute("data-kute-style")) span.setAttribute("data-kute-style", span.getAttribute("style") ?? "");
            span.setAttribute("style", css);
            span.setAttribute("data-kute-clan", match?.[1] ?? "");
        }
    }
}

const clanColors = new ClanColors();
kute.clanColors = clanColors;
export default clanColors;
