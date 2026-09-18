import { kute } from "../client.js";
import { waitForElement } from "../utils.js";

/**
 * Replaces the ping display with an ICMP ping measured by the host.
 */
class RealPing {
    constructor(){
        /** @type {HTMLElement|null} */
        this.ingamePing = null;
        /** @type {HTMLElement|null} */
        this.menuPing = null;
        /** @type {number|null} */
        this.interval = null;
        /** @type {((event: MessageEvent) => void)|null} */
        this.listener = null;

        kute.settings.toggleRealPing = (enabled) => this.toggle(enabled);
        this.toggle(true);
    }

    /**
     * Blocks the game from overwriting the element's text.
     *
     * @param {HTMLElement|null} element
     */
    applyPingDisplay(element){
        if (!element) return;
        Object.defineProperty(element, "textContent", {
            set: () => {},
            configurable: true,
        });
    }

    /**
     * @param {boolean} enabled
     * @return {Promise<void>}
     */
    async toggle(enabled){
        const [ingamePing, menuPing] = await Promise.all([waitForElement("#pingText"), waitForElement("#menuPingText")]);
        this.ingamePing = ingamePing;
        this.menuPing = menuPing;

        if (enabled){
            this.applyPingDisplay(ingamePing);
            this.applyPingDisplay(menuPing);
            this.interval = setInterval(() => {
                window.chrome.webview.postMessage("ping");
            }, 3000);

            this.listener = (event) => {
                const ping = event.data?.pingInfo;
                if (!ping) return;
                // innerText, because textContent is what the game writes to and is blocked on these two
                ingamePing.innerText = ping;
                menuPing.innerText = ping;
            };
            window.chrome.webview.addEventListener("message", this.listener);
        }
        else {
            if (this.interval !== null) clearInterval(this.interval);
            if (this.listener) window.chrome.webview.removeEventListener("message", this.listener);
            this.interval = null;
            this.listener = null;
            // drop the instance overrides so the prototype's textContent works again
            Reflect.deleteProperty(ingamePing, "textContent");
            Reflect.deleteProperty(menuPing, "textContent");
        }
    }
}

export default new RealPing();
