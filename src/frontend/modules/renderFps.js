import { kute } from "../client.js";
import { waitForElement } from "../utils.js";

// present fps next to the game's counter, only while fresh and plausible (the hook can miss the game's swap chain)
// krunker's own counter writes are the clock, no timer

const STALE_MS = 2000;
// hook is blind: far fewer presents than frames AND few in absolute terms, the gap alone is no proof
const BLIND_SHARE = 0.25;
const BLIND_MAX = 60;
// hysteresis against flicker
const SWITCH_AFTER_MS = 3000;

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
        this.presentFps = 0;
        this.presentAt = 0;
        this.showPresent = true;
        /** 0 while present value agrees with what is shown */
        this.disagreeSince = 0;
        this.shown = "";
        kute.settings.toggleRenderFps = (enabled) => this.toggle(enabled);
        this.toggle(true);
    }

    /**
     * @return {boolean} last present value is fresh and fits the game fps
     */
    presentUsable(){
        if (performance.now() - this.presentAt > STALE_MS) return false;
        const game = Number.parseFloat(this.gameFPS ?? "");
        if (!Number.isFinite(game) || game <= 0) return true;
        return !(this.presentFps < game * BLIND_SHARE && this.presentFps < BLIND_MAX);
    }

    evaluate(){
        const now = performance.now();
        if (this.presentUsable() === this.showPresent) this.disagreeSince = 0;
        else if (!this.disagreeSince) this.disagreeSince = now;
        else if (now - this.disagreeSince >= SWITCH_AFTER_MS){
            this.showPresent = !this.showPresent;
            this.disagreeSince = 0;
            if (!this.showPresent) this.explainOnce();
        }
        this.render();
    }

    explainOnce(){
        try {
            if (sessionStorage.getItem("kute_presentFpsHidden")) return;
            sessionStorage.setItem("kute_presentFpsHidden", "1");
        }
        catch {
            return;
        }
        kute.showNotification?.(kute.settings?.data?.hardFlip === false
            ? "Present FPS needs the DXGI Swapchain Hook (Settings, Advanced), which is off. Showing the game's FPS"
            : "Present FPS is hidden: the swap chain hook does not see the game's frames on this PC, its number would be wrong. Showing the game's FPS", false, 8);
    }

    render(){
        const text = this.showPresent && this.presentAt > 0 ? `${this.gameFPS ?? ""} ${this.presentFps}` : (this.gameFPS ?? "");
        // skip unchanged, 10 host messages a second
        if (text === this.shown) return;
        this.shown = text;
        if (this.ingameFPS) this.ingameFPS.innerText = text;
        if (this.menuFPS) this.menuFPS.innerText = text;
    }

    /**
     * @param {HTMLElement|null} element
     */
    applyFpsDisplay(element){
        if (!element) return;
        Object.defineProperty(element, "textContent", {
            set: (value) => {
                this.gameFPS = value;
                this.evaluate();
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

            this.listener = (event) => {
                const fps = event.data?.fpsInfo;
                if (typeof fps !== "number") return;
                this.presentFps = fps;
                this.presentAt = performance.now();
                if (this.showPresent) this.render();
            };

            window.chrome.webview.addEventListener("message", this.listener);
        }
        else {
            if (this.listener){
                window.chrome.webview.removeEventListener("message", this.listener);
                this.listener = null;
            }
            Reflect.deleteProperty(ingameFPS, "textContent");
            Reflect.deleteProperty(menuFPS, "textContent");
        }
    }
}

export default new RenderFps();
