// krunker rebuilds My Inventory from page one after a quicksell, listing or destroy, and its sentinel observer never
// fires again because the sentinel never left the view. this keeps the view and refills the pages through that loader

// measured: the list resets ~0.7 s after the popup's button, a slow server answers later
const RESET_AFTER_POPUP_MS = 5000;
const RESTORE_LIMIT_MS = 10000;
// no new page for this long: the inventory has no more
const PAGE_WAIT_MS = 1500;
// quicksell and destroy open a view stack overlay, listing a modal overlay
const POPUPS = ".view-stack-overlay, .modal-overlay";

/**
 * @typedef {object} Restore
 * @property {HTMLElement} scroller
 * @property {HTMLElement} grid
 * @property {Set<HTMLElement>} sentinels every one styled, the inventory's end removes it and the reset makes a new one
 * @property {number} top
 * @property {number} count items before the reset
 * @property {number} until
 * @property {number} pageTimer
 * @property {HTMLElement} picture the removed cards, shown over the grid until it is full again
 */

/**
 * @param {HTMLElement} grid
 * @return {HTMLElement|null}
 */
function sentinelOf(grid){
    const next = grid.nextElementSibling;
    return next instanceof HTMLElement && next.matches(".market-grid-sentinel") ? next : null;
}

/**
 * @return {Promise<void>}
 */
const nextFrame = () => new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
});

/**
 * @param {number} count
 * @return {Promise<void>}
 */
async function frames(count){
    for (let frame = 0; frame < count; frame++) await nextFrame();
}

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
                if (event.target instanceof Element && event.target.closest(POPUPS)) this.popupClickAt = performance.now();
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
        // the pages come back one by one over ~150 ms, blank or half filled frames read as a jump
        const picture = document.createElement("div");
        picture.className = grid.className;
        picture.style.cssText = grid.style.cssText;
        picture.append(...removed);
        this.restore = { scroller, grid, sentinels: new Set(), top: this.lastTop, count, until: performance.now() + RESTORE_LIMIT_MS, pageTimer: 0, picture };
        grid.style.minHeight = `${this.lastHeight}px`;
        // the held height stretched the few rows there are into huge gaps
        grid.style.alignContent = "start";
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
        scroller.addEventListener("wheel", this.onWheel, { passive: true });
        this.waitForPage();
        this.blink(this.restore).catch((error) => console.error("[kute] inventory scroll:", error));
    }

    pageArrived(){
        const { restore } = this;
        if (!restore) return;
        // a quicksell or destroy leaves one item less
        if (restore.grid.children.length >= restore.count - 1 || performance.now() > restore.until) this.finish(true);
        else this.waitForPage();
    }

    waitForPage(){
        const { restore } = this;
        if (!restore) return;
        clearTimeout(restore.pageTimer);
        restore.pageTimer = window.setTimeout(() => this.finish(true), PAGE_WAIT_MS);
    }

    /**
     * @param {Restore} restore
     * @return {Promise<void>}
     */
    async blink(restore){
        while (this.restore === restore){
            // the end of the inventory removes the sentinel and the reset makes a new one, so it is looked up every time
            const sentinel = sentinelOf(restore.grid);
            if (sentinel){
                // stuck to the bottom of the view the sentinel is always in it, every blink then asks for the next page
                restore.sentinels.add(sentinel);
                sentinel.style.position = "sticky";
                sentinel.style.bottom = "0";
                sentinel.style.display = "none";
                await frames(2);
                sentinel.style.display = "";
            }
            // the loader ignores the sentinel while the game is busy with the list call and then never hears of it
            // again (the original bug), so it blinks until the pages are back. observers run after rAF, so the
            // visible state needs two frames to be seen
            await frames(2);
        }
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
        restore.grid.style.alignContent = "";
        restore.scroller.style.overflowAnchor = "";
        for (const sentinel of restore.sentinels){
            sentinel.style.position = "";
            sentinel.style.bottom = "";
            sentinel.style.display = "";
        }
        if (putBack) restore.scroller.scrollTop = restore.top;
        this.lastTop = restore.scroller.scrollTop;
        this.lastHeight = restore.grid.offsetHeight;
    }
}

export default new InventoryScroll();
