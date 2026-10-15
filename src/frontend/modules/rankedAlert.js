import { kute } from "../client.js";

/**
 * Brings Kute to the front when krunker's own ranked queue finds a match while the player is tabbed out. Krunker
 * accepts the match by itself a second later, so the class pick already runs when the player is back.
 */

// krunker's svelte status line under the play buttons, "Searching for match... (0:12)" then this
const STATUS = ".ranked-matchmaking-status";
const FOUND = "Match found!";

class RankedAlert {
    constructor(){
        this.found = false;
        /** @type {Element|null} */
        this.status = null;
        this.observer = new MutationObserver(() => this.check());
        kute.settings.toggleRankedAlert = (enabled) => this.toggle(enabled);
        this.toggle(true);
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        this.observer.disconnect();
        if (!enabled) return;
        this.status = document.querySelector(STATUS);
        if (!this.status) return;
        // the line ticks once a second while searching, nothing else touches it
        this.observer.observe(this.status, { attributes: true, attributeFilter: ["class"], childList: true, characterData: true, subtree: true });
        this.found = this.shown();
    }

    /**
     * @return {boolean} idle, the hidden line already reads "Match found!", only .show makes it real
     */
    shown(){
        return Boolean(this.status?.classList.contains("show")) && this.status?.textContent === FOUND;
    }

    check(){
        const found = this.shown();
        // document.hasFocus() stays true while another app is in front, the host knows better
        if (found && !this.found) window.chrome.webview.postMessage("bring-to-front");
        this.found = found;
    }
}

export default new RankedAlert();
