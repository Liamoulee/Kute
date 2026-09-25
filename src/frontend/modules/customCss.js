import { kute, ready } from "../client.js";

// constructed sheets drop @import, those go into a <style> of their own
const IMPORTS = /@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;?/gi;

/**
 * @return {boolean}
 */
export const hostSupportsCustomCss = () => kute.hostFeatures?.includes("custom-css") ?? false;

class CustomCss {
    constructor(){
        // saved on disk. only on window during bundle eval, so this module is imported statically
        this.saved = String(/** @type {any} */ (window).__kuteCustomCss ?? "");
        this.enabled = true;
        /** @type {CSSStyleSheet|null} */
        this.sheet = null;
        /** @type {HTMLStyleElement|null} */
        this.importStyle = null;
        this.importText = "";
        this.waitingForBody = false;
        if (this.saved) this.apply(this.saved);

        ready.then(() => {
            kute.settings.toggleCustomCss = (enabled) => this.toggle(enabled);
            if (kute.settings.data.customCss === false) this.toggle(false);
            // the renderer reads the toggle from disk, a change inside the 1 s save delay is not there yet
            else if (!this.saved && hostSupportsCustomCss()) this.load().then((css) => this.apply(css));
        });
    }

    /**
     * @return {Promise<string>}
     */
    load(){
        return new Promise((resolve) => {
            /**
             * @param {MessageEvent} event
             */
            const listener = (event) => {
                if (typeof event.data?.customCss?.content !== "string") return;
                window.chrome.webview.removeEventListener("message", listener);
                this.saved = event.data.customCss.content;
                resolve(this.saved);
            };
            window.chrome.webview.addEventListener("message", listener);
            window.chrome.webview.postMessage("css-read");
        });
    }

    /**
     * Adopted sheets come after every sheet of the document in the cascade, so these win ties against krunker's.
     *
     * @param {string} css
     */
    apply(css){
        if (!this.enabled) return;
        const imports = css.match(IMPORTS) ?? [];
        const rules = imports.length ? css.replace(IMPORTS, "") : css;
        if (!this.sheet){
            if (!rules.trim()) return;
            this.sheet = new CSSStyleSheet();
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.sheet];
        }
        this.sheet.replaceSync(rules);
        this.setImports(imports.join("\n"));
    }

    /**
     * Last child of <html>, after head and body, so imported themes still come after krunker's styles.
     *
     * @param {string} text
     */
    setImports(text){
        this.importText = text;
        if (!text && !this.importStyle) return;
        if (document.readyState === "loading"){
            if (this.waitingForBody) return;
            this.waitingForBody = true;
            document.addEventListener("DOMContentLoaded", () => this.setImports(this.importText), { once: true });
            return;
        }
        if (!this.importStyle){
            this.importStyle = document.createElement("style");
            document.documentElement.append(this.importStyle);
        }
        if (this.importStyle.textContent !== text) this.importStyle.textContent = text;
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        this.enabled = enabled;
        if (!enabled){
            this.sheet?.replaceSync("");
            this.setImports("");
            return;
        }
        if (this.saved) this.apply(this.saved);
        else if (hostSupportsCustomCss()) this.load().then((css) => this.apply(css));
    }

    /**
     * @param {string} css
     */
    markSaved(css){
        this.saved = css;
        this.apply(css);
    }

    revert(){
        if (this.enabled) this.apply(this.saved);
    }
}

export default new CustomCss();
