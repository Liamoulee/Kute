import { kute } from "../client.js";
import playerLists from "./playerLists.js";
import presence, { playerHash } from "./presence.js";
import badge from "../components/badge.webp";

// Draws the Kute badge next to everybody in the lobby who runs Kute. presence.js knows who that is (a set of
// hashes), playerLists.js hands over the rows, this module only decides per row: one Map lookup for the name's
// hash, one Set lookup against the roster. Nothing here scans anything.
//
// The "Show Cute Badge" setting is cosmetic: off means no badges get drawn, the client still announces itself.

/** @typedef {import("./playerLists.js").Row} Row */

// Where the badge goes and how it is boxed, per list. Krunker writes inline styles on its own badge images,
// the same on every row of a list, and these are those values (read from the live page), so ours sits in the
// row exactly like one of theirs. The rows of both leaderboards are flex containers: margin-top places an icon
// there, vertical-align does nothing.
//
// One thing Krunker never has to deal with: its images bring margin-left:2px, its material icons (the verified
// mark) bring no margin at all, and it always puts icons before images. Our badge goes first, so an icon can
// follow it, and then the two boxes touch (measured: 0 px where every other gap is 2 px). ICON_GAP fixes that.
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

/**
 * Takes every badge out again.
 */
function removeBadges(){
    for (const img of document.querySelectorAll("[data-kute-badge]")) img.remove();
    for (const element of document.querySelectorAll("[data-kute-badged]")) element.removeAttribute("data-kute-badged");
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
        this.enabled = kute.settings.data.cuteBadge !== false;
        /** @type {(row: Row) => void} */
        this.decorator = (row) => this.decorate(row);

        kute.settings.toggleCuteBadge = (enabled) => this.toggle(enabled);
        presence.listeners.add(() => this.rosterChanged());
        if (this.enabled) playerLists.add(this.decorator);
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        this.enabled = enabled;
        if (enabled) playerLists.add(this.decorator);
        else {
            playerLists.remove(this.decorator);
            removeBadges();
        }
    }

    /**
     * Somebody came or went: a handful of rows, so everything gets drawn again from the roster.
     */
    rosterChanged(){
        if (presence.game !== this.game){
            this.game = presence.game;
            this.hashes.clear();
            this.pending.clear();
        }
        if (!this.enabled) return;
        removeBadges();
        playerLists.refresh();
    }

    /**
     * @param {Row} row
     */
    decorate(row){
        if (presence.roster.size === 0 || row.name === "" || row.element.hasAttribute("data-kute-badged")) return;
        const hash = this.hashes.get(row.name);
        if (hash === undefined){
            this.learn(row.name);
            return;
        }
        if (presence.roster.has(hash)) this.insert(row);
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
     * alt list.
     *
     * @param {Row} row
     */
    insert(row){
        const { element, kind } = row;
        const parent = element.parentElement;
        if (!parent) return;
        const img = document.createElement("img");
        img.src = badge;
        img.setAttribute("data-kute-badge", "");
        img.alt = "";
        img.title = "Kute";
        img.style.cssText = PLACEMENT[kind];
        if (kind === "alt") element.append(img);
        else if (kind === "end") parent.insertBefore(img, element.nextSibling);
        else parent.insertBefore(img, parent.firstElementChild?.nextSibling ?? element);
        if (img.nextElementSibling?.tagName === "I") img.style.marginRight = ICON_GAP;
        element.setAttribute("data-kute-badged", "");
    }
}

const badges = new Badges();
kute.badges = badges;
export default badges;
