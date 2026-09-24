/** @typedef {"leader" | "ingame" | "alt" | "end"} ListKind */

/**
 * @typedef {object} Row
 * @property {Element} element holds the name and the clan span
 * @property {string} name without clan tag and icons
 * @property {ListKind} kind
 */

/** @typedef {(row: Row) => void} Decorator */
/** @typedef {(kind: ListKind) => void} WalkEnd */

/** own span next to the name, exactly "[tag]" */
const CLAN_TAG = /^\s*\[(.+)\]\s*$/;

/**
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

/** containers verified in the live game */
const LISTS = /** @type {{ list: string, kind: ListKind, root: string }[]} */ ([
    { list: "leaderContainer", kind: "leader", root: "leaderboardHolder" },
    { list: "ingameTable", kind: "ingame", root: "centerLeaderDisplay" },
    { list: "endTable", kind: "end", root: "endUI" },
    { list: "playerListH", kind: "alt", root: "menuWindow" },
]);

const DISCOVERY_MS = 1000;

/** leaderboard classes get a suffix: M = own row, F = others */
const NAME_ELEMENTS = ".pListName, [class^=\"newLeaderName\"], [class^=\"leaderName\"], .endTableN";

/**
 * @param {Element} nameElement
 * @return {string} name without clan tag and icons
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
        /** @type {Map<Decorator, WalkEnd | undefined>} */
        this.decorators = new Map();
        /** @type {{ observer: MutationObserver, target: Element, list: string, kind: ListKind }[]} */
        this.watched = [];
        this.timer = 0;
    }

    /**
     * calls decorator per row, now and on every rebuild. onWalkEnd runs once per list after its rows
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
     * safety net: observes a list that shows up outside the watched containers
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

    refresh(){
        for (const entry of this.watched) this.walk(entry);
    }

    /**
     * @param {{ observer: MutationObserver, target: Element, list: string, kind: ListKind }} entry
     */
    walk(entry){
        // containers hold more than the list, the id decides. team modes have one table per team with the same id
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
        // our own inserts must not trigger another walk
        entry.observer.takeRecords();
    }
}

export default new PlayerLists();
