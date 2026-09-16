/**
 * Shows the render (presented) FPS reported by the host next to the game's own FPS counter.
 */
class RenderFps {
    constructor(){
        /** @type {HTMLElement|null} */
        this.ingameFPS = null;
        /** @type {HTMLElement|null} */
        this.menuFPS = null;
        /** @type {((event: MessageEvent) => void)|null} */
        this.listener = null;
        /** @type {string|null} */
        this.gameFPS = null;
        window.kute.settings.toggleRenderFps = (enabled) => this.toggle(enabled);
        this.toggle(true);
    }

    /**
     * Captures the game's FPS writes instead of letting them reach the element.
     *
     * @param {HTMLElement|null} element
     */
    applyFpsDisplay(element){
        if (!element) return;
        Object.defineProperty(element, "textContent", {
            set: (value) => {
                this.gameFPS = value;
            },
            configurable: true,
        });
    }

    /**
     * @param {boolean} enabled
     * @return {Promise<void>}
     */
    async toggle(enabled){
        [this.ingameFPS, this.menuFPS] = await Promise.all([waitForElement("#ingameFPS"), waitForElement("#menuFPS")]);

        if (enabled){
            this.applyFpsDisplay(this.ingameFPS);
            this.applyFpsDisplay(this.menuFPS);

            this.listener = (event) => {
                const fps = event.data?.fpsInfo;
                if (fps === undefined) return;

                if (this.ingameFPS) this.ingameFPS.innerText = `${this.gameFPS} ${fps}`;
                if (this.menuFPS) this.menuFPS.innerText = `${this.gameFPS} ${fps}`;
            };

            window.chrome.webview.addEventListener("message", this.listener);
        }
        else {
            if (this.listener){
                window.chrome.webview.removeEventListener("message", this.listener);
                this.listener = null;
            }
            if (this.ingameFPS) delete this.ingameFPS.textContent;
            if (this.menuFPS) delete this.menuFPS.textContent;
        }
    }
}

export default new RenderFps();
