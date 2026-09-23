import { kute } from "../client.js";
import { waitForElement } from "../utils.js";

/**
 * Shows the render (presented) FPS reported by the host next to the game's own FPS counter.
 *
 * The number comes from the swap chain hook, and on some PCs the hook does not see the swap chain that carries the
 * game's frames: two players saw 0, 1 or 27 next to a game running smoothly at 180. The host also only sends a value
 * that is above 0 and changed, so a hook that sees nothing leaves the last number standing. Neither may reach the
 * screen as a present rate. So the second number is only shown while it is fresh and plausible, and the game's own
 * counter is shown alone otherwise. Krunker's own writes of its counter (about ten a second) are the clock for that
 * check, this adds nothing to a frame and no timer.
 */

// a present value older than this is not a present rate any more (the host sends ten a second while it has one)
const STALE_MS = 2000;
// "the hook does not see the game": far fewer presents than frames AND few in absolute terms. Real frames piling
// up behind the GPU (stock Chromium) still measured 313 presents against 1527 frames, so the gap alone is no proof
const BLIND_SHARE = 0.25;
const BLIND_MAX = 60;
// how long a change has to hold before the display switches, either way, so one odd moment does not make it flicker
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
        /** when the present value started to disagree with what is shown, 0 while it agrees */
        this.disagreeSince = 0;
        this.shown = "";
        kute.settings.toggleRenderFps = (enabled) => this.toggle(enabled);
        this.toggle(true);
    }

    /**
     * @return {boolean} Whether the last present value is fresh and fits the game's frame rate
     */
    presentUsable(){
        if (performance.now() - this.presentAt > STALE_MS) return false;
        const game = Number.parseFloat(this.gameFPS ?? "");
        // no game number to compare with (menu before the first write): nothing speaks against it
        if (!Number.isFinite(game) || game <= 0) return true;
        return !(this.presentFps < game * BLIND_SHARE && this.presentFps < BLIND_MAX);
    }

    /**
     * Called for every game counter write (Krunker writes each counter about ten times a second): decides what is
     * shown, switching only once a change has held for SWITCH_AFTER_MS.
     */
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
        // ten host messages a second, often with the numbers that are already on screen
        if (text === this.shown) return;
        this.shown = text;
        if (this.ingameFPS) this.ingameFPS.innerText = text;
        if (this.menuFPS) this.menuFPS.innerText = text;
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
            // drop the instance overrides so the prototype's textContent works again
            Reflect.deleteProperty(ingameFPS, "textContent");
            Reflect.deleteProperty(menuFPS, "textContent");
        }
    }
}

export default new RenderFps();
