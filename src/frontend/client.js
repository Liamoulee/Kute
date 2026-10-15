import cSettings from "../cSettings.json";
import { overridePerformance } from "./performance.js";

/**
 * @param {number} length
 * @return {string}
 */
function randomKey(length){
    const chars = "abcdefghijklmnopqrstuvwxyz";
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

/**
 * filled by the get-info reply. never put it on window.kute
 *
 * @type {Kute}
 */
export const kute = /** @type {Kute} */ ({});

/**
 * @type {Promise<Kute>}
 */
export const ready = new Promise((resolve) => {
    /**
     * @param {MessageEvent} event
     */
    function handler(event){
        if (event?.data?.settings || event?.data?.version){
            window.chrome.webview.removeEventListener("message", handler);
            Object.assign(kute, event.data);
            // an exe older than a setting does not send it, Config::load fills the same defaults on the host
            if (kute.settings?.data){
                for (const setting of Object.values(/** @type {Record<string, {id: string, defaultValue?: unknown}>} */ (cSettings))){
                    if (setting.defaultValue !== undefined && !(setting.id in kute.settings.data)) kute.settings.data[setting.id] = setting.defaultValue;
                }
            }
            // before anything reads a setting
            if (kute.settings?.data) overridePerformance(kute.settings.data, kute.settings.data.performanceMode === true);
            resolve(kute);
        }
    }

    window.chrome.webview.addEventListener("message", handler);
    window.chrome.webview.postMessage("get-info");
});

// random hidden global, in case krunker pulls a bs move like with idkr
const globalKey = randomKey(12);
Object.defineProperty(window, globalKey, {
    value: kute,
    enumerable: false,
    writable: false,
    configurable: false,
});

/**
 * for inline handler strings
 *
 * @type {string}
 */
export const globalRef = `window["${globalKey}"]`;
