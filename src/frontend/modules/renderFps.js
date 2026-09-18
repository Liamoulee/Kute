import { kute } from "../client.js";
import { waitForElement } from "../utils.js";

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
        kute.settings.toggleRenderFps = (enabled) => this.toggle(enabled);
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
        const [ingameFPS, menuFPS] = await Promise.all([waitForElement("#ingameFPS"), waitForElement("#menuFPS")]);
        this.ingameFPS = ingameFPS;
        this.menuFPS = menuFPS;

        if (enabled){
            this.applyFpsDisplay(ingameFPS);
            this.applyFpsDisplay(menuFPS);

            let shown = "";
            this.listener = (event) => {
                const fps = event.data?.fpsInfo;
                if (fps === undefined) return;

                // ten of these arrive per second, often with the numbers that are already on screen
                const text = `${this.gameFPS} ${fps}`;
                if (text === shown) return;
                shown = text;
                ingameFPS.innerText = text;
                menuFPS.innerText = text;
            };

            window.chrome.webview.addEventListener("message", this.listener);
        }
        else {
            if (this.listener){
                window.chrome.webview.removeEventListener("message", this.listener);
                this.listener = null;
            }
            // drop the instance overrides so the prototype's textContent works again
            Reflect.deleteProperty(ingameFPS, "textContent");
            Reflect.deleteProperty(menuFPS, "textContent");
        }
    }
}

export default new RenderFps();
