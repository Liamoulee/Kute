/** @typedef {"leader" | "ingame" | "alt" | "end"} ListKind */

/**
 * @typedef {object} Row
 * @property {Element} element The element holding the name (and the clan span)
 * @property {string} name The name as Krunker wrote it, without clan tag and icons
 * @property {ListKind} kind
 */

/** @typedef {(row: Row) => void} Decorator */
/** @typedef {(kind: ListKind) => void} WalkEnd */

/** a clan tag as Krunker renders it: a span of its own next to the name, holding exactly "[tag]" */
const CLAN_TAG = /^\s*\[(.+)\]\s*$/;

/**
 * The clan tag of a row, for the decorators that care (clan colors paint it, the developer badge is bound to it).
 *
 * @param {Element} nameElement
 * @return {{ span: Element, tag: string } | null}
 */
export function clanTag(nameElement){
    for (const span of nameElement.children){
        if (span.tagName !== "SPAN") continue;
        const match = CLAN_TAG.exec(span.textContent ?? "");
        if (match) return { span, tag: match[1] };
    }
    return null;
}

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
        /** @type {Map<Decorator, WalkEnd | undefined>} decorator -> what to call once a list is walked */
        this.decorators = new Map();
        /** @type {{ observer: MutationObserver, target: Element, list: string, kind: ListKind }[]} */
        this.watched = [];
        this.timer = 0;
    }

    /**
     * Starts handing every row to decorator, now and after every rebuild. A decorator that has to decide
     * something about a list as a whole (the developer badge needs to know whether a row is the only one of
     * its kind) gets onWalkEnd called once per walked list, after its rows.
     *
     * @param {Decorator} decorator
     * @param {WalkEnd} [onWalkEnd]
     */
    add(decorator, onWalkEnd){
        this.decorators.set(decorator, onWalkEnd);
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
        // the containers hold more than the list (the menu window holds every window): the id decides. Team modes
        // show one table per team, all with the same id, and together they are still one list
        const lists = document.querySelectorAll(`#${entry.list}`);
        if (lists.length > 0){
            for (const list of lists){
                for (const element of list.querySelectorAll(NAME_ELEMENTS)){
                    const row = { element, name: nameOf(element), kind: entry.kind };
                    for (const decorator of this.decorators.keys()) decorator(row);
                }
            }
            for (const onWalkEnd of this.decorators.values()) onWalkEnd?.(entry.kind);
        }
        // what the decorators just inserted must not come back as another walk
        entry.observer.takeRecords();
    }
}

export default new PlayerLists();
