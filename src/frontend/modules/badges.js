import { kute } from "../client.js";
import playerLists, { clanTag } from "./playerLists.js";
import presence, { playerHash } from "./presence.js";
import badge from "../components/badge.webp";
import devBadge from "../components/devBadge.webp";

/** @typedef {import("./playerLists.js").Row} Row */
/** @typedef {import("./playerLists.js").ListKind} ListKind */
/** @typedef {{ row: Row, hash: string, tag: string | undefined }} Candidate */

// krunker's material icons have no margin, so we add one when one follows
const ICON_GAP = "2px";
const PLACEMENT = {
    // <div.leaderItem> counter, [icons], name, score
    leader: "margin-top:5px;vertical-align:middle;height:21px;margin-left:2px",
    ingame: "margin-top:3px;vertical-align:middle;height:21px;margin-left:2px",
    // <td> pfp, name link, [icons]
    end: "margin-top:-12px;vertical-align:middle;width:26px;margin-left:2px",
    // <td.pListName> [ping], [material icon], name, clan. goes after the clan tag, top offset because the pixel font sits high
    alt: "vertical-align:middle;height:21px;margin-left:6px;position:relative;top:-0.35em",
};

const ART = { kute: badge, dev: devBadge };
const TITLE = { kute: "Kute", dev: "Kute Developer" };

/**
 * @param {"kute" | "dev"} [kind]
 */
function removeBadges(kind){
    const badges = kind ? `[data-kute-badge="${kind}"]` : "[data-kute-badge]";
    for (const img of document.querySelectorAll(badges)) img.remove();
    const rows = kind ? `[data-kute-badged="${kind}"]` : "[data-kute-badged]";
    for (const element of document.querySelectorAll(rows)) element.removeAttribute("data-kute-badged");
}

/**
 * badge sits inside the name element or next to it
 *
 * @param {Element} element
 */
function removeBadgeOf(element){
    const img = element.querySelector("[data-kute-badge]") ?? element.parentElement?.querySelector("[data-kute-badge]");
    img?.remove();
    element.removeAttribute("data-kute-badged");
}

class Badges {
    constructor(){
        this.game = "";
        /** @type {Map<string, string>} name -> hash, once per lobby */
        this.hashes = new Map();
        /** @type {Set<string>} */
        this.pending = new Set();
        /** a freshly hashed name is in the roster */
        this.found = false;
        /** @type {Candidate[]} rows in the current walk that claim a dev */
        this.candidates = [];
        this.enabled = kute.settings.data.cuteBadge !== false;
        /** @type {(row: Row) => void} */
        this.decorator = (row) => this.decorate(row);
        /** @type {() => void} */
        this.finisher = () => this.finish();

        kute.settings.toggleCuteBadge = (enabled) => this.toggle(enabled);
        presence.listeners.add(() => this.rosterChanged());
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        this.enabled = enabled;
        // dev badges stay either way
        if (!enabled) removeBadges("kute");
        playerLists.refresh();
    }

    /**
     * redraws everything, it's a handful of rows
     */
    rosterChanged(){
        if (presence.game !== this.game){
            this.game = presence.game;
            this.hashes.clear();
            this.pending.clear();
        }
        removeBadges();
        if (presence.roster.size === 0){
            playerLists.remove(this.decorator);
            return;
        }
        // add() (re)sets the decorator and walks the lists
        playerLists.add(this.decorator, this.finisher);
    }

    /**
     * @param {Row} row
     */
    decorate(row){
        if (presence.roster.size === 0 || row.name === "") return;
        const hash = this.hashes.get(row.name);
        if (hash === undefined){
            this.learn(row.name);
            return;
        }
        // dev rows are decided in finish()
        if (presence.devs.has(hash)){
            this.candidates.push({ row, hash, tag: clanTag(row.element)?.tag });
            return;
        }
        if (this.enabled && !row.element.hasAttribute("data-kute-badged") && presence.roster.has(hash)) this.insert(row, "kute");
    }

    /**
     * dev badge goes to the one row with the dev's clan tag, or the only claimant if no row has tags.
     * ambiguous gets nothing
     */
    finish(){
        if (this.candidates.length === 0) return;
        /** @type {Map<string, Candidate[]>} */
        const claims = new Map();
        for (const candidate of this.candidates){
            const group = claims.get(candidate.hash);
            if (group) group.push(candidate);
            else claims.set(candidate.hash, [candidate]);
        }

        for (const [hash, group] of claims){
            const tagged = group.filter((candidate) => candidate.tag === presence.devs.get(hash));
            let winner = null;
            if (tagged.length === 1) winner = tagged[0].row;
            else if (tagged.length === 0 && group.length === 1) winner = group[0].row;

            for (const candidate of group){
                const drawn = candidate.row.element.getAttribute("data-kute-badged");
                if (candidate.row !== winner){
                    // dev claimants never get a normal badge either
                    if (drawn) removeBadgeOf(candidate.row.element);
                    continue;
                }
                if (drawn === "dev") continue;
                if (drawn) removeBadgeOf(candidate.row.element);
                this.insert(candidate.row, "dev");
            }
        }
        this.candidates.length = 0;
    }

    /**
     * webcrypto is async, so a new name costs one extra walk
     *
     * @param {string} name
     */
    async learn(name){
        if (this.pending.has(name)) return;
        this.pending.add(name);
        const { game } = this;
        const hash = await playerHash(game, name);
        if (game !== this.game) return;
        this.pending.delete(name);
        this.hashes.set(name, hash);
        if (presence.roster.has(hash)) this.found = true;
        // one walk for all names that showed up together
        if (this.pending.size > 0 || !this.found) return;
        this.found = false;
        playerLists.refresh();
    }

    /**
     * @param {Row} row
     * @param {"kute" | "dev"} kind
     */
    insert(row, kind){
        const { element } = row;
        const parent = element.parentElement;
        if (!parent) return;
        const img = document.createElement("img");
        img.src = ART[kind];
        img.setAttribute("data-kute-badge", kind);
        img.alt = "";
        img.title = TITLE[kind];
        img.style.cssText = PLACEMENT[row.kind];
        if (row.kind === "alt") element.append(img);
        else if (row.kind === "end") parent.insertBefore(img, element.nextSibling);
        else parent.insertBefore(img, parent.firstElementChild?.nextSibling ?? element);
        if (img.nextElementSibling?.tagName === "I") img.style.marginRight = ICON_GAP;
        element.setAttribute("data-kute-badged", kind);
    }
}

const badges = new Badges();
kute.badges = badges;
export default badges;
