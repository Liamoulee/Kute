import { request } from "../utils.js";

/**
 * Real pings in Find Game: next to every server, and in the old browser layout on each region heading with the
 * regions sorted fastest first. The pings are the host's `ping-regions` (ICMP to a lobby server per region, cached
 * 60 s there). Krunker rebuilds #serverHolder's html on every refresh and search, so this re-applies after each one.
 */

const PING_ATTR = "data-kute-ping";
const MAX_AGE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** @type {Record<string, string>} game id prefix -> region key of the ping reply, from the game list */
const PREFIX_REGIONS = {
    FRA: "de-fra", NY: "us-nj", DAL: "us-tx", SV: "us-ca-sv", BRZ: "brz", SIN: "sgp", TOK: "jb-hnd", SYD: "au-syd",
    MBI: "as-mb", BHN: "me-bhn", SSS: "sss",
};

/** @type {Record<string, string>} old layout heading -> region key, krunker's region names */
const NAME_REGIONS = {
    "New York": "us-nj", Dallas: "us-tx", Frankfurt: "de-fra", "Silicon Valley": "us-ca-sv", Sydney: "au-syd",
    Tokyo: "jb-hnd", Singapore: "sgp", Mumbai: "as-mb", Brazil: "brz", "Middle East": "me-bhn",
    "EU Super Secret Servers": "sss",
};

const STYLE = `
#serverHolder .settNameIn .kutePing { float: right; margin-right: 8px; color: #35e0e8; font-size: 13px; line-height: 44px; }
#serverHolder .setHed .kutePing { float: right; margin-right: 14px; color: #35e0e8; font-size: 0.75em; line-height: 42px; }
`;

/**
 * @param {number|undefined} ping
 * @return {string}
 */
const label = (ping) => (ping === undefined ? "" : `${ping} ms`);

class ServerPings {
    constructor(){
        /** @type {Record<string, number>} */
        this.pings = {};
        this.fetchedAt = 0;
        this.fetching = false;
        /** @type {ReturnType<typeof setTimeout>|null} */
        this.pending = null;
        // the time left of every server ticks once a second, a burst ends in one cheap pass
        this.observer = new MutationObserver(() => {
            if (this.pending === null) this.pending = setTimeout(() => this.scan(), 150);
        });
        const style = document.createElement("style");
        style.textContent = STYLE;
        document.head.append(style);
        const menu = document.getElementById("menuWindow");
        if (!menu) return;
        this.menu = menu;
        this.observer.observe(menu, { childList: true, subtree: true });
    }

    refresh(){
        if (this.fetching || Date.now() - this.fetchedAt < MAX_AGE_MS) return;
        this.fetching = true;
        request("ping-regions", "regionPings", REQUEST_TIMEOUT_MS).then((pings) => {
            this.fetching = false;
            // an exe without the command answers nothing, try again next minute
            this.fetchedAt = Date.now();
            if (!pings) return;
            this.pings = pings;
            // labels from the previous minute get rewritten
            this.menu?.querySelectorAll(".kutePing").forEach((element) => element.remove());
            this.menu?.querySelectorAll(`[${PING_ATTR}]`).forEach((element) => element.removeAttribute(PING_ATTR));
            this.scan();
        });
    }

    scan(){
        this.pending = null;
        const holder = document.getElementById("serverHolder");
        if (!holder) return;
        this.refresh();
        if (Object.keys(this.pings).length === 0) return;
        this.observer.disconnect();
        this.labelRows(holder);
        this.sortRegions(holder);
        if (this.menu) this.observer.observe(this.menu, { childList: true, subtree: true });
    }

    /**
     * @param {HTMLElement} holder
     */
    labelRows(holder){
        for (const row of holder.querySelectorAll(`.settNameIn:not([${PING_ATTR}])`)){
            row.setAttribute(PING_ATTR, "");
            // checkedSwitchServer("FRA:abcde", ...)
            const prefix = /checkedSwitchServer\("([A-Z]+):/.exec(row.getAttribute("onclick") ?? "")?.[1];
            const ping = prefix ? this.pings[PREFIX_REGIONS[prefix]] : undefined;
            const icon = row.querySelector(".serverPing");
            if (ping === undefined || !icon) continue;
            const text = document.createElement("span");
            text.className = "kutePing";
            text.textContent = label(ping);
            icon.after(text);
        }
    }

    /**
     * old browser layout only: a .setHed per region, its servers in the .setBodH after it while expanded
     *
     * @param {HTMLElement} holder
     */
    sortRegions(holder){
        /** @type {{nodes: Element[], ping: number}[]} */
        const blocks = [];
        for (const child of holder.children){
            if (child.classList.contains("setHed")){
                // direct text only, the player count and Quick Join are children
                const name = Array.from(child.childNodes, (node) => (node.nodeType === Node.TEXT_NODE ? node.textContent : "")).join("").trim();
                const ping = this.pings[NAME_REGIONS[name]];
                if (ping !== undefined && !child.hasAttribute(PING_ATTR)){
                    child.setAttribute(PING_ATTR, "");
                    const text = document.createElement("span");
                    text.className = "kutePing";
                    text.textContent = label(ping);
                    child.querySelector(".quickJoin")?.before(text);
                }
                // official, custom and the default region keep krunker's spot on top
                blocks.push({ nodes: [child], ping: ping ?? -1 });
            }
            else blocks.at(-1)?.nodes.push(child);
        }
        if (blocks.length < 2) return;
        const sorted = blocks.map((block, index) => ({ ...block, index })).sort((a, b) => (a.ping - b.ping) || (a.index - b.index));
        // the onclicks carry krunker's index, moving the nodes keeps them right
        if (sorted.every((block, index) => block.index === index)) return;
        for (const block of sorted) holder.append(...block.nodes);
    }
}

export default new ServerPings();
