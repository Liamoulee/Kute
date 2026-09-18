// One watcher for Krunker's four player lists (the alt list, the in-game scoreboard, the top right leaderboard and
// the end screen), shared by the modules that decorate them (clan colors, the Kute badge). The lists come and go
// with the match state, so the ones that exist get looked up twice a second and observed for Krunker's rebuilds.
// Every subscriber gets called with a list element whenever that list appears or changes.

const LISTS = ["#playerListH", "#ingameTable", "#leaderboardHolder", "#endTable"];

/** the elements holding a player's name in the four lists (the leaderboard classes get a suffix: M for the own row, F for others) */
export const NAME_ELEMENTS = ".pListName, [class^=\"newLeaderName\"], [class^=\"leaderName\"], .endTableN";

/**
 * @param {Element} nameElement
 * @return {string} The name as Krunker wrote it, without the clan tag span and the icons around it
 */
export function nameOf(nameElement){
    let name = "";
    for (const node of nameElement.childNodes){
        if (node.nodeType === Node.TEXT_NODE) name += node.textContent ?? "";
    }
    return name.trim();
}

/** @typedef {(list: Element) => void} ListHandler */

class PlayerLists {
    constructor(){
        /** @type {Set<ListHandler>} */
        this.handlers = new Set();
        /** @type {Map<Element, MutationObserver>} */
        this.observers = new Map();
        this.timer = 0;
    }

    /**
     * Starts calling handler for every list that exists now and every change later.
     *
     * @param {ListHandler} handler
     */
    subscribe(handler){
        this.handlers.add(handler);
        for (const list of this.observers.keys()) handler(list);
        this.scan();
        if (!this.timer) this.timer = setInterval(() => this.scan(), 500);
    }

    /**
     * @param {ListHandler} handler
     */
    unsubscribe(handler){
        this.handlers.delete(handler);
        if (this.handlers.size > 0) return;
        clearInterval(this.timer);
        this.timer = 0;
        for (const observer of this.observers.values()) observer.disconnect();
        this.observers.clear();
    }

    /**
     * Four querySelector calls: notifies about the lists that exist and observes new ones.
     */
    scan(){
        for (const [list, observer] of this.observers){
            if (list.isConnected) continue;
            observer.disconnect();
            this.observers.delete(list);
        }
        for (const selector of LISTS){
            const list = document.querySelector(selector);
            if (!list) continue;
            this.notify(list);
            if (this.observers.has(list)) continue;
            const observer = new MutationObserver(() => this.notify(list));
            observer.observe(list, { childList: true, subtree: true });
            this.observers.set(list, observer);
        }
    }

    /**
     * @param {Element} list
     */
    notify(list){
        for (const handler of this.handlers) handler(list);
    }
}

export default new PlayerLists();
