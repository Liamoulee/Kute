import { kute } from "../client.js";
import playerLists, { NAME_ELEMENTS, nameOf } from "./playerLists.js";
import badge from "../components/badge.webp";

// The Kute badge next to the names of everybody in the match who runs Kute. Every client tells the Kute server
// which match it is in (POST /api/presence) and gets back who else is there. A player is only ever a per-match
// hash of the game id and the name, so the server never sees a name and the hash means nothing outside the match.
//
// The announce runs whenever the account is logged in (guests have random names, so nothing runs for them).
// The "Show Cute Badge" setting is cosmetic: off means no badges get drawn, the client still announces itself.

const PRESENCE_URL = "https://kute.lol/api/presence";
/** the server sends its own interval with every answer, this is the value until the first one */
const DEFAULT_INTERVAL_S = 30;
/** a name in the lists that has no badge yet makes the client ask again, but not more often than this */
const JOIN_REFRESH_MS = 5000;

/**
 * @return {boolean}
 */
function loggedIn(){
    return document.querySelector("#signedInHeaderBar") !== null;
}

/**
 * @return {{ id: string, user: string } | null} The current match and the own name, null in the menu or logged out
 */
function currentGame(){
    const activity = window.getGameActivity?.();
    const id = activity?.id;
    const user = activity?.user;
    if (typeof id !== "string" || typeof user !== "string" || id.length === 0 || user.length === 0) return null;
    return { id, user };
}

/**
 * @param {string} game
 * @param {string} name
 * @return {Promise<string>} 16 bytes of sha256(game + "\n" + name) as hex
 */
async function playerHash(game, name){
    const bytes = new TextEncoder().encode(game + "\n" + name);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Takes every badge out again.
 */
function removeBadges(){
    for (const img of document.querySelectorAll("[data-kute-badge]")) img.remove();
    for (const element of document.querySelectorAll("[data-kute-badged]")) element.removeAttribute("data-kute-badged");
}

class CuteBadge {
    constructor(){
        /** the match the presence below belongs to */
        this.game = "";
        /** @type {Set<string>} hashes of the Kute players in this match */
        this.present = new Set();
        /** @type {Map<string, string>} name -> hash, per match, so the lists do not hash on every rebuild */
        this.hashes = new Map();
        /** @type {Set<string>} names the server was already asked about in this match */
        this.asked = new Set();
        this.url = PRESENCE_URL;
        this.intervalS = DEFAULT_INTERVAL_S;
        this.lastPost = 0;
        this.posting = false;
        /** set by the list handler when a name without a badge showed up */
        this.wantRefresh = false;
        this.enabled = kute.settings.data.cuteBadge !== false;
        /** @type {(list: Element) => void} */
        this.handler = (list) => this.decorate(list);

        kute.settings.toggleCuteBadge = (enabled) => this.toggle(enabled);
        playerLists.subscribe(this.handler);
        setInterval(() => this.tick(), 1000);
        this.tick();
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        this.enabled = enabled;
        if (enabled){
            playerLists.scan();
            return;
        }
        removeBadges();
    }

    /**
     * Once a second: announces every interval, sooner when a new name appeared in the lists.
     */
    tick(){
        if (this.posting) return;
        const game = loggedIn() ? currentGame() : null;
        if (!game){
            this.forget();
            return;
        }
        if (game.id !== this.game){
            this.forget();
            this.game = game.id;
        }
        const now = Date.now();
        const due = this.lastPost + this.intervalS * 1000;
        const join = this.wantRefresh && now - this.lastPost >= JOIN_REFRESH_MS;
        if (now < due && !join) return;
        this.wantRefresh = false;
        this.lastPost = now;
        this.announce(game).catch(() => {
            // no server, no badges
        });
    }

    /**
     * Drops what belonged to the previous match.
     */
    forget(){
        if (!this.game) return;
        this.game = "";
        this.present.clear();
        this.hashes.clear();
        this.asked.clear();
        this.lastPost = 0;
        removeBadges();
    }

    /**
     * @param {{ id: string, user: string }} game
     */
    async announce(game){
        this.posting = true;
        try {
            const hash = await this.hashOf(game.id, game.user);
            const response = await fetch(this.url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ game: game.id, hash }),
            });
            if (!response.ok) return;
            const answer = await response.json();
            // the match may have changed while the request was out
            if (game.id !== this.game) return;
            if (Array.isArray(answer?.players)) this.present = new Set(answer.players.filter((/** @type {unknown} */ player) => typeof player === "string"));
            // whoever is in the lists now has been asked about with this answer
            for (const name of this.hashes.keys()) this.asked.add(name);
            if (typeof answer?.interval === "number" && answer.interval >= 5) this.intervalS = answer.interval;
            playerLists.scan();
        }
        finally {
            this.posting = false;
        }
    }

    /**
     * @param {string} game
     * @param {string} name
     * @return {Promise<string>}
     */
    async hashOf(game, name){
        let hash = this.hashes.get(name);
        if (!hash){
            hash = await playerHash(game, name);
            if (game === this.game) this.hashes.set(name, hash);
        }
        return hash;
    }

    /**
     * Puts the badge in front of every name in the list that is present, and asks for a refresh when a name is not.
     *
     * @param {Element} list
     */
    decorate(list){
        if (!this.enabled || !this.game) return;
        const {game} = this;
        for (const element of list.querySelectorAll(NAME_ELEMENTS)){
            if (element.hasAttribute("data-kute-badged")) continue;
            const name = nameOf(element);
            if (!name) continue;
            const known = this.hashes.get(name);
            if (known === undefined){
                // hashing is async, the list gets another pass once the hash is there
                this.hashOf(game, name).then(() => { if (game === this.game) this.decorate(list); });
                continue;
            }
            if (!this.present.has(known)){
                // a joiner announces itself within the interval, one extra ask per new name catches it sooner
                if (!this.asked.has(name)){
                    this.asked.add(name);
                    this.wantRefresh = true;
                }
                continue;
            }
            this.insert(element);
        }
    }

    /**
     * Puts the badge in as the first icon of the row: right after the rank in the leaderboards, first in the
     * alt list cell, before the name link on the end screen. The box is the one Krunker gives its own badges there.
     *
     * @param {Element} element A name element
     */
    insert(element){
        const row = element.parentElement;
        if (!row) return;
        const img = document.createElement("img");
        img.src = badge;
        img.setAttribute("data-kute-badge", "");
        img.alt = "";
        img.title = "Kute";
        const { className } = element;
        if (className.startsWith("leaderName")){
            img.style.cssText = "margin-top:5px;vertical-align:middle;height:21px;margin-left:2px";
            row.insertBefore(img, row.querySelector(".leaderCounter")?.nextSibling ?? element);
        }
        else if (className.startsWith("newLeaderName")){
            img.style.cssText = "margin-top:3px;vertical-align:middle;height:21px;margin-left:2px";
            row.insertBefore(img, row.querySelector(".newLeaderCounter")?.nextSibling ?? element);
        }
        else if (className === "endTableN"){
            img.style.cssText = "vertical-align:middle;width:26px;margin-right:2px";
            row.insertBefore(img, element);
        }
        else {
            img.style.cssText = "vertical-align:middle;height:21px;margin-right:2px";
            element.insertBefore(img, element.firstChild);
        }
        element.setAttribute("data-kute-badged", "");
    }
}

const cuteBadge = new CuteBadge();
kute.cuteBadge = cuteBadge;
export default cuteBadge;
