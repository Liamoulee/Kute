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
 * @property {string} image file name in Documents\kute\skies, or "preset:<name>" for one built into the exe
 */

/** @type {CustomSkyConfig} same defaults as skybox.rs */
const DEFAULT_CONFIG = { mode: "gradient", zenith: "#1E5AA8", horizon: "#9FD0F0", image: "" };
const PRESET_PREFIX = "preset:";

/** @type {[string, string, string][]} name, top, horizon */
const GRADIENTS = [
    ["Vaporwave", "#ff00aa", "#00ffcc"],
    ["Kute", "#0b2e3a", "#35e0e8"],
    ["Sunset", "#2b1055", "#ff8a4c"],
    ["Midnight", "#03040f", "#243b73"],
    ["Toxic", "#0a2a12", "#a6ff3b"],
    ["Blood Moon", "#120006", "#b3122e"],
    ["Cotton Candy", "#8fb8ff", "#ffc2e2"],
];

/** @type {Record<string, string>} host preset name -> label */
const PRESET_LABELS = {
    starfield: "Starfield",
    aurora: "Aurora",
    nebula: "Nebula",
    synthwave: "Synthwave",
    sunset: "Sunset",
    candy: "Cotton Clouds",
};

class CustomSky {
    constructor(){
        kute.customSky = { showOptions: () => this.showOptions() };
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
     * @return {Promise<{files: string[], presets: string[]}>}
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
                resolve({ files: event.data.skies, presets: Array.isArray(event.data.skyPresets) ? event.data.skyPresets : [] });
            };
            timeout = window.setTimeout(() => {
                window.chrome.webview.removeEventListener("message", listener);
                resolve({ files: [], presets: [] });
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
            const { files, presets } = await this.listImages();
            /**
             * @param {string} label
             * @param {[string, string][]} entries value, text
             * @return {HTMLOptGroupElement}
             */
            const group = (label, entries) => {
                const optgroup = document.createElement("optgroup");
                optgroup.label = label;
                optgroup.append(...entries.map(([value, text]) => new Option(text, value)));
                return optgroup;
            };
            const values = [...presets.map((name) => PRESET_PREFIX + name), ...files];
            image.replaceChildren(
                ...(presets.length ? [group("Kute", presets.map((name) => [PRESET_PREFIX + name, PRESET_LABELS[name] ?? name]))] : []),
                ...(files.length ? [group("Your images", files.map((name) => [name, name]))] : []),
            );
            if (values.length > 0 && !values.includes(config.image)) config.image = values[0];
            image.value = config.image;
            image.disabled = values.length === 0;
            element("skImageHint").textContent = files.length === 0
                ? "Add your own: put PNG, JPG or WEBP images into Documents\\kute\\skies, then press Refresh"
                : "Put PNG, JPG or WEBP images into Documents\\kute\\skies";
        };

        const swatches = element("skSwatches");
        for (const [name, top, bottom] of GRADIENTS){
            const swatch = document.createElement("div");
            swatch.className = "skSwatch";
            swatch.title = name;
            swatch.style.background = `linear-gradient(${top}, ${bottom})`;
            swatch.onclick = () => {
                config.zenith = top;
                config.horizon = bottom;
                zenith.value = top;
                horizon.value = bottom;
                render();
            };
            swatches.append(swatch);
        }

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
