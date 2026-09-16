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

        window.kute.settings.toggleRealPing = (enabled) => this.toggle(enabled);
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
        [this.ingamePing, this.menuPing] = await Promise.all([
            waitForElement("#pingText"),
            waitForElement("#menuPingText"),
        ]);
        if (enabled){
            this.applyPingDisplay(this.ingamePing);
            this.applyPingDisplay(this.menuPing);
            this.interval = setInterval(() => {
                window.chrome.webview.postMessage("ping");
            }, 3000);

            this.listener = (event) => {
                if (!event.data.pingInfo) return;
                this.ingamePing.innerText = event.data.pingInfo;
                this.menuPing.innerText = event.data.pingInfo;
            };
            window.chrome.webview.addEventListener("message", this.listener);
        }
        else {
            clearInterval(this.interval);
            window.chrome.webview.removeEventListener("message", this.listener);
            delete this.ingamePing.textContent;
            delete this.menuPing.textContent;
        }
    }
}

export default new RealPing();
