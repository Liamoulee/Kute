import { kute } from "../client.js";

/**
 * Options for the custom sky. The host does the work: it rewrites the dome fields of each map config and answers
 * the texture requests with the chosen image, so a change applies from the next match.
 */

/**
 * @typedef {object} CustomSkyConfig
 * @property {"gradient"|"image"} mode
 * @property {string} zenith #rrggbb
 * @property {string} horizon #rrggbb
 * @property {string} image file name in Documents\kute\skies
 */

/** @type {CustomSkyConfig} same defaults as skybox.rs */
const DEFAULT_CONFIG = { mode: "gradient", zenith: "#1E5AA8", horizon: "#9FD0F0", image: "" };

class CustomSky {
    constructor(){
        kute.customSky = { showOptions: () => this.showOptions() };
        kute.settings.toggleCustomSky = () => kute.showNotification("Custom sky applies from the next match", false, 4);
    }

    /**
     * @return {CustomSkyConfig}
     */
    get config(){
        return { ...DEFAULT_CONFIG, ...kute.settings.data.customSkyConfig };
    }

    /**
     * @param {CustomSkyConfig} config
     */
    saveConfig(config){
        kute.settings.data.customSkyConfig = config;
        window.chrome.webview.postMessage(`set-config-json customSkyConfig ${JSON.stringify(config)}`);
    }

    /**
     * @return {Promise<string[]>}
     */
    listImages(){
        return new Promise((resolve) => {
            /** @type {number} */
            let timeout = 0;
            /** @param {MessageEvent} event */
            const listener = (event) => {
                if (!Array.isArray(event.data?.skies)) return;
                window.chrome.webview.removeEventListener("message", listener);
                clearTimeout(timeout);
                resolve(event.data.skies);
            };
            timeout = window.setTimeout(() => {
                window.chrome.webview.removeEventListener("message", listener);
                resolve([]);
            }, 3000);
            window.chrome.webview.addEventListener("message", listener);
            window.chrome.webview.postMessage("sky-list");
        });
    }

    async showOptions(){
        const html = await import("../components/customSkyOptions.html");
        const { config } = this;

        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = html.default;

        /**
         * @param {string} id
         * @return {HTMLElement}
         */
        const element = (id) => /** @type {HTMLElement} */ (shadow.querySelector(`#${id}`));
        const zenith = /** @type {HTMLInputElement} */ (element("skZenith"));
        const horizon = /** @type {HTMLInputElement} */ (element("skHorizon"));
        const image = /** @type {HTMLSelectElement} */ (element("skImage"));

        const render = () => {
            element("skModeGradient").classList.toggle("active", config.mode === "gradient");
            element("skModeImage").classList.toggle("active", config.mode === "image");
            element("skGradientPane").hidden = config.mode !== "gradient";
            element("skImagePane").hidden = config.mode !== "image";
            element("skPreview").style.background = `linear-gradient(${config.zenith}, ${config.horizon})`;
        };

        const fillImages = async() => {
            const names = await this.listImages();
            image.replaceChildren(...names.map((name) => new Option(name, name, false, name === config.image)));
            if (names.length > 0 && !names.includes(config.image)) config.image = names[0];
            image.disabled = names.length === 0;
            element("skImageHint").textContent = names.length === 0
                ? "No images yet. Put PNG, JPG or WEBP images into Documents\\kute\\skies, then press Refresh"
                : "Put PNG, JPG or WEBP images into Documents\\kute\\skies";
        };

        zenith.value = config.zenith.toLowerCase();
        horizon.value = config.horizon.toLowerCase();
        zenith.oninput = () => {
            config.zenith = zenith.value;
            render();
        };
        horizon.oninput = () => {
            config.horizon = horizon.value;
            render();
        };
        image.onchange = () => {
            config.image = image.value;
        };
        element("skModeGradient").onclick = () => {
            config.mode = "gradient";
            render();
        };
        element("skModeImage").onclick = () => {
            config.mode = "image";
            render();
        };
        element("skOpenFolder").onclick = () => window.chrome.webview.postMessage("open, skies");
        element("skRefresh").onclick = () => fillImages();

        const controller = new AbortController();
        const close = () => {
            controller.abort();
            overlay.remove();
            this.saveConfig(config);
        };
        element("skDone").onclick = close;
        overlay.addEventListener("mousedown", (event) => {
            if (event.target === overlay) close();
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                close();
            },
            { signal: controller.signal, capture: true },
        );

        render();
        document.body.append(overlay);
        await fillImages();
    }
}

export default new CustomSky();
