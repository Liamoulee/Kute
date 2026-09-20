import { kute } from "../client.js";
import playerLists, { clanTag } from "./playerLists.js";
import presence, { playerHash } from "./presence.js";
import badge from "../components/badge.webp";
import devBadge from "../components/devBadge.webp";

/** @typedef {import("./playerLists.js").Row} Row */
/** @typedef {import("./playerLists.js").ListKind} ListKind */
/** @typedef {{ row: Row, hash: string, tag: string | undefined }} Candidate */

const ICON_GAP = "2px";
const PLACEMENT = {
    // <div.leaderItem> counter, [icons], name, score
    leader: "margin-top:5px;vertical-align:middle;height:21px;margin-left:2px",
    // <div.newLeaderItem>, the same in a smaller font
    ingame: "margin-top:3px;vertical-align:middle;height:21px;margin-left:2px",
    // <td> pfp, name link, [icons]
    end: "margin-top:-12px;vertical-align:middle;width:26px;margin-left:2px",
    // <td.pListName> [ping], [material icon], name, clan: Krunker has no badge image here, and the front of the
    // cell is where the ping goes, so ours follows the clan tag. the pixel font sits high in its line box, so
    // the middle of the text is 0.35em above where vertical-align puts the image
    alt: "vertical-align:middle;height:21px;margin-left:6px;position:relative;top:-0.35em",
};

const ART = { kute: badge, dev: devBadge };
const TITLE = { kute: "Kute", dev: "Kute Developer" };

/**
 * Takes badges out again, of one kind or all of them.
 *
 * @param {"kute" | "dev"} [kind]
 */
function removeBadges(kind){
    const badges = kind ? `[data-kute-badge="${kind}"]` : "[data-kute-badge]";
    for (const img of document.querySelectorAll(badges)) img.remove();
    const rows = kind ? `[data-kute-badged="${kind}"]` : "[data-kute-badged]";
    for (const element of document.querySelectorAll(rows)) element.removeAttribute("data-kute-badged");
}

/**
 * Takes the badge of one row out again. It sits inside the name element or next to it, and there is one name
 * element per row, so the row's own badge is the only one either of those holds.
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
        /** the lobby the hashes below were made for */
        this.game = "";
        /** @type {Map<string, string>} name -> hash, so a name gets hashed once per lobby */
        this.hashes = new Map();
        /** @type {Set<string>} names whose hash is being made */
        this.pending = new Set();
        /** one of the names that just got their hash is in the roster */
        this.found = false;
        /** @type {Candidate[]} rows of the list being walked that claim a developer */
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
        // the developer badges stay either way
        if (!enabled) removeBadges("kute");
        playerLists.refresh();
    }

    /**
     * Somebody came or went: a handful of rows, so everything gets drawn again from the roster. The lists are
     * only watched while there is anybody to draw, which is also what makes a developer badge independent of
     * the setting: what decides is the roster, not "Show Cute Badge".
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
        // add() sets the decorator (again) and walks the lists
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
        // a developer's hash is never drawn as an ordinary badge: which row it belongs to is decided in finish()
        if (presence.devs.has(hash)){
            this.candidates.push({ row, hash, tag: clanTag(row.element)?.tag });
            return;
        }
        if (this.enabled && !row.element.hasAttribute("data-kute-badged") && presence.roster.has(hash)) this.insert(row, "kute");
    }

    /**
     * A list has been walked: now it is known whether a row claiming a developer is the only one doing so.
     * The badge goes to the row that also carries the developer's clan tag. If none of them does, the list
     * shows no tags at all (a Krunker change, or a mode without them) and the only row there is gets it.
     * Anything ambiguous gets nothing.
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
                    // a row claiming a developer never carries an ordinary badge either
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
     * Hashing is async (WebCrypto), so a new name cannot be decided in the walk that found it: the lists get
     * walked once more when its hash is there. Once per name and lobby.
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
        // one walk for all the names that showed up together
        if (this.pending.size > 0 || !this.found) return;
        this.found = false;
        playerLists.refresh();
    }

    /**
     * Puts the badge in as the first icon of the row: right after the rank in the leaderboards, and where the
     * icons follow the name, right behind it: after the name link on the end screen, after the clan tag in the
     * alt list. A developer badge goes exactly where the ordinary one would, it replaces it.
     *
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
