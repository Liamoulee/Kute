// krunker rebuilds My Inventory from page one after a quicksell, listing or destroy, and its sentinel observer never
// fires again because the sentinel never left the view. this keeps the view and refills the pages through that loader

// measured: the list resets ~0.7 s after the popup's button, a slow server answers later
const RESET_AFTER_POPUP_MS = 5000;
const RESTORE_LIMIT_MS = 10000;
// no new page after a kick: the inventory has no more
const PAGE_WAIT_MS = 1500;

/**
 * @typedef {object} Restore
 * @property {HTMLElement} scroller
 * @property {HTMLElement} grid
 * @property {HTMLElement|null} sentinel
 * @property {number} top
 * @property {number} count items before the reset
 * @property {number} until
 * @property {number} pageTimer
 * @property {HTMLElement} picture the removed cards, shown over the grid until it is full again
 */

/**
 * @return {Promise<void>}
 */
const nextFrame = () => new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
});

class InventoryScroll {
    constructor(){
        /** @type {WeakSet<Element>} */
        this.watched = new WeakSet();
        this.popupClickAt = -Infinity;
        this.lastTop = 0;
        this.lastHeight = 0;
        /** @type {Restore|null} */
        this.restore = null;
        this.onWheel = () => this.finish(false);

        document.addEventListener("scroll", (event) => this.onScroll(event), { capture: true, passive: true });
        document.addEventListener(
            "click",
            (event) => {
                if (event.target instanceof Element && event.target.closest(".view-stack-overlay")) this.popupClickAt = performance.now();
            },
            { capture: true, passive: true },
        );
    }

    /**
     * @param {Event} event
     */
    onScroll(event){
        const scroller = event.target;
        if (!(scroller instanceof HTMLElement)) return;
        if (this.restore){
            // every arriving page pulled the view up (12632 to 2968 over four pages). scroll events run before the
            // frame is drawn, so putting it back here never shows
            if (scroller === this.restore.scroller && scroller.scrollTop !== this.restore.top) scroller.scrollTop = this.restore.top;
            return;
        }
        const grid = scroller.querySelector(":scope > .market-grid");
        if (!(grid instanceof HTMLElement)) return;
        this.watch(scroller, grid);
        this.lastTop = scroller.scrollTop;
        this.lastHeight = grid.offsetHeight;
    }

    /**
     * @param {HTMLElement} scroller
     * @param {HTMLElement} grid
     */
    watch(scroller, grid){
        if (this.watched.has(grid)) return;
        this.watched.add(grid);
        let count = grid.children.length;
        // childList of the grid only, goes away with the grid
        new MutationObserver((records) => {
            const removed = records.reduce((sum, record) => sum + record.removedNodes.length, 0);
            const before = count;
            count = grid.children.length;
            if (this.restore?.grid === grid){
                if (count > before) this.pageArrived();
                return;
            }
            const reset = before > 0 && removed >= before;
            if (reset && this.lastTop > scroller.clientHeight && performance.now() - this.popupClickAt < RESET_AFTER_POPUP_MS){
                this.start(scroller, grid, before, records.flatMap((record) => [...record.removedNodes]));
            }
        }).observe(grid, { childList: true });
    }

    /**
     * runs in the mutation callback, before the browser lays out the emptied grid and clamps the scroll position
     *
     * @param {HTMLElement} scroller
     * @param {HTMLElement} grid
     * @param {number} count
     * @param {Node[]} removed
     */
    start(scroller, grid, count, removed){
        const sentinel = grid.nextElementSibling instanceof HTMLElement && grid.nextElementSibling.matches(".market-grid-sentinel") ? grid.nextElementSibling : null;
        // the pages come back one by one over ~150 ms, blank or half filled frames read as a jump
        const picture = document.createElement("div");
        picture.className = grid.className;
        picture.style.cssText = grid.style.cssText;
        picture.append(...removed);
        this.restore = { scroller, grid, sentinel, top: this.lastTop, count, until: performance.now() + RESTORE_LIMIT_MS, pageTimer: 0, picture };
        grid.style.minHeight = `${this.lastHeight}px`;
        Object.assign(picture.style, {
            position: "absolute",
            top: `${grid.offsetTop}px`,
            left: `${grid.offsetLeft}px`,
            width: `${grid.offsetWidth}px`,
            margin: "0",
            zIndex: "1",
            pointerEvents: "none",
        });
        // the grid's sibling, so both measure from the same offset parent
        scroller.append(picture);
        scroller.style.overflowAnchor = "none";
        scroller.scrollTop = this.lastTop;
        // stuck to the bottom of the view the sentinel is always in it, every blink then asks for the next page
        if (sentinel){
            sentinel.style.position = "sticky";
            sentinel.style.bottom = "0";
        }
        scroller.addEventListener("wheel", this.onWheel, { passive: true });
        this.kick();
    }

    pageArrived(){
        const { restore } = this;
        if (!restore) return;
        // a quicksell or destroy leaves one item less
        if (restore.grid.children.length >= restore.count - 1 || performance.now() > restore.until) this.finish(true);
        else this.kick();
    }

    async kick(){
        const { restore } = this;
        if (!restore) return;
        clearTimeout(restore.pageTimer);
        restore.pageTimer = window.setTimeout(() => this.finish(true), PAGE_WAIT_MS);
        if (!restore.sentinel) return;
        restore.sentinel.style.display = "none";
        await nextFrame();
        await nextFrame();
        if (this.restore === restore) restore.sentinel.style.display = "";
    }

    /**
     * @param {boolean} putBack false when the player scrolled meanwhile
     */
    finish(putBack){
        const { restore } = this;
        if (!restore) return;
        this.restore = null;
        clearTimeout(restore.pageTimer);
        restore.scroller.removeEventListener("wheel", this.onWheel);
        restore.picture.remove();
        restore.grid.style.minHeight = "";
        restore.scroller.style.overflowAnchor = "";
        if (restore.sentinel){
            restore.sentinel.style.position = "";
            restore.sentinel.style.bottom = "";
            restore.sentinel.style.display = "";
        }
        if (putBack) restore.scroller.scrollTop = restore.top;
        this.lastTop = restore.scroller.scrollTop;
        this.lastHeight = restore.grid.offsetHeight;
    }
}

export default new InventoryScroll();
