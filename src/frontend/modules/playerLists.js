// The one place that looks at Krunker's four player lists (the top right leaderboard, the in-game scoreboard,
// the alt list and the end screen). Decorators (clan colors, badges) get every row handed to them, so a rebuild
// by Krunker costs one walk over the rows, no matter how many features draw into them.
//
// The lists come and go, but they live inside containers that are part of Krunker's page from the start, so
// those containers get observed once and a rebuild is noticed the moment it happens. A list that turns up
// somewhere else (wherever a Krunker update moves things) is found by one id lookup per second and then
// observed itself. What the decorators insert is a mutation too, those records get dropped right after
// a walk, otherwise every rebuild would be handled twice.
// Measured in a live match: about one rebuild every two seconds, about five microseconds per walk.

/** @typedef {"leader" | "ingame" | "alt" | "end"} ListKind */

/**
 * @typedef {object} Row
 * @property {Element} element The element holding the name (and the clan span)
 * @property {string} name The name as Krunker wrote it, without clan tag and icons
 * @property {ListKind} kind
 */

/** @typedef {(row: Row) => void} Decorator */

/** the lists, what kind each is, and the permanent container it lives in (all four verified in the live game) */
const LISTS = /** @type {{ list: string, kind: ListKind, root: string }[]} */ ([
    { list: "leaderContainer", kind: "leader", root: "leaderboardHolder" },
    { list: "ingameTable", kind: "ingame", root: "centerLeaderDisplay" },
    { list: "endTable", kind: "end", root: "endUI" },
    { list: "playerListH", kind: "alt", root: "menuWindow" },
]);

const DISCOVERY_MS = 1000;

/** the elements holding a player's name (the leaderboard classes get a suffix: M for the own row, F for others) */
const NAME_ELEMENTS = ".pListName, [class^=\"newLeaderName\"], [class^=\"leaderName\"], .endTableN";

/**
 * @param {Element} nameElement
 * @return {string} The name as Krunker wrote it, without the clan tag span and the icons around it
 */
function nameOf(nameElement){
    let name = "";
    for (const node of nameElement.childNodes){
        if (node.nodeType === Node.TEXT_NODE) name += node.textContent ?? "";
    }
    return name.trim();
}

class PlayerLists {
    constructor(){
        /** @type {Set<Decorator>} */
        this.decorators = new Set();
        /** @type {{ observer: MutationObserver, target: Element, list: string, kind: ListKind }[]} */
        this.watched = [];
        this.timer = 0;
    }

    /**
     * Starts handing every row to decorator, now and after every rebuild.
     *
     * @param {Decorator} decorator
     */
    add(decorator){
        this.decorators.add(decorator);
        if (this.watched.length === 0) this.observe();
        this.refresh();
    }

    /**
     * @param {Decorator} decorator
     */
    remove(decorator){
        this.decorators.delete(decorator);
        if (this.decorators.size > 0) return;
        for (const { observer } of this.watched) observer.disconnect();
        this.watched = [];
        clearInterval(this.timer);
        this.timer = 0;
    }

    observe(){
        for (const { root, list, kind } of LISTS){
            const element = document.getElementById(root);
            if (element) this.watch(element, list, kind);
        }
        this.timer = setInterval(() => this.discover(), DISCOVERY_MS);
    }

    /**
     * @param {Element} target
     * @param {string} list
     * @param {ListKind} kind
     */
    watch(target, list, kind){
        const entry = { observer: new MutationObserver(() => this.walk(entry)), target, list, kind };
        entry.observer.observe(target, { childList: true, subtree: true });
        this.watched.push(entry);
        this.walk(entry);
    }

    /**
     * The safety net: a list that exists outside of everything that is being observed gets observed itself,
     * until Krunker removes it again.
     */
    discover(){
        this.watched = this.watched.filter((entry) => {
            if (entry.target.isConnected) return true;
            entry.observer.disconnect();
            return false;
        });
        for (const { list, kind } of LISTS){
            const element = document.getElementById(list);
            if (element && !this.watched.some((entry) => entry.target.contains(element))) this.watch(element, list, kind);
        }
    }

    /**
     * Walks every list that exists right now (after the roster or a setting changed).
     */
    refresh(){
        for (const entry of this.watched) this.walk(entry);
    }

    /**
     * @param {{ observer: MutationObserver, target: Element, list: string, kind: ListKind }} entry
     */
    walk(entry){
        // the containers hold more than the list (the menu window holds every window): one id lookup decides
        const list = document.getElementById(entry.list);
        if (list){
            for (const element of list.querySelectorAll(NAME_ELEMENTS)){
                const row = { element, name: nameOf(element), kind: entry.kind };
                for (const decorator of this.decorators) decorator(row);
            }
        }
        // what the decorators just inserted must not come back as another walk
        entry.observer.takeRecords();
    }
}

export default new PlayerLists();
