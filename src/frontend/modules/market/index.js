import { kute } from "../../client.js";
import api from "../api.js";
import marketApi from "./api.js";
import cards from "./cards.js";
import trade from "./trade.js";
import alerts, { UNREAD_EVENT } from "./alerts.js";
import contrib from "./contrib.js";

class Market {
    constructor(){
        /** @type {HTMLDivElement} */
        this.headerItem = document.createElement("div");
        /** @type {HTMLDivElement} */
        this.headerSeparator = document.createElement("div");
        /** @type {MutationObserver} */
        this.headerObserver = new MutationObserver(() => this.placeButton());
        this.onUnread = () => this.updateBadge();
        /** @type {typeof import("./terminal.js").default|null} */
        this.terminal = null;
        this.running = false;
        this.warned = false;

        kute.settings.toggleMarket = (enabled) => this.toggle(enabled);
        kute.market = { open: (tab, arg) => this.open(tab, arg), toggle: (enabled) => this.toggle(enabled) };
        this.toggle(true);
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        if (enabled === this.running) return;
        this.running = enabled;
        if (enabled){
            if (!marketApi.hostSupported()){
                // a bundle on an exe without the signing message: say so once, load nothing
                if (!this.warned){
                    this.warned = true;
                    kute.showNotification("The Kute Market needs a newer Kute. Update Kute to use it.", false, 8);
                }
                this.running = false;
                return;
            }
            if (api.offline()){
                this.running = false;
                return;
            }
            this.placeButton();
            const header = document.querySelector("#playerHeaderEl");
            if (header) this.headerObserver.observe(header, { childList: true, subtree: true });
            window.addEventListener(UNREAD_EVENT, this.onUnread);
            cards.start();
            trade.start();
            alerts.start();
            contrib.start();
        }
        else {
            this.headerObserver.disconnect();
            window.removeEventListener(UNREAD_EVENT, this.onUnread);
            this.headerItem.remove();
            this.headerSeparator.remove();
            cards.stop();
            trade.stop();
            alerts.stop();
            contrib.stop();
            this.terminal?.close();
        }
    }

    /** next to the account manager's entry in the header, which runs the same placement */
    placeButton(){
        const right = document.querySelector("#playerHeaderEl .headerBarRight");
        if (!right) return;
        if (right.contains(this.headerItem)) return;
        const scope = [...(right.querySelector(".nav-item")?.classList ?? [])].find((name) => name.startsWith("svelte-")) ?? "";
        this.headerItem.className = `nav-item ${scope}`;
        // the inbox's own markup and classes, so the count looks like krunker's mail badge
        this.headerItem.innerHTML = `<div class="nav-icon-wrap ${scope}"><span class="material-icons nav-mat-icon ${scope}">candlestick_chart</span></div> <span class="nav-label ${scope}">Kute Market</span> <div class="nav-badge ${scope}" style="display: none;"></div>`;
        this.headerItem.onclick = () => this.open(alerts.unread.size ? "watchlist" : undefined);
        this.headerSeparator.className = "verticalSeparator";
        this.headerSeparator.style.cssText = "height: 35px;";
        right.prepend(this.headerItem, this.headerSeparator);
        this.updateBadge();
    }

    updateBadge(){
        const badge = /** @type {HTMLElement|null} */ (this.headerItem.querySelector(".nav-badge"));
        if (!badge) return;
        const count = alerts.unread.size;
        badge.textContent = String(Math.min(99, count));
        badge.style.display = count ? "inline-block" : "none";
    }

    /**
     * opens the terminal, on a tab when asked
     *
     * @param {string} [tab]
     * @param {unknown} [arg] the skin for the item tab, the name for the portfolio
     */
    async open(tab, arg){
        if (!this.running) return;
        if (!this.terminal){
            const module = await import("./terminal.js").catch(() => null);
            if (!module) return;
            this.terminal = module.default;
        }
        await this.terminal.open(tab, arg);
    }
}

const market = new Market();
export default market;
