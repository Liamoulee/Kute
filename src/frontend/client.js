/**
 * Generates a random lowercase identifier.
 *
 * @param {number} length
 * @return {string}
 */
function randomKey(length){
    const chars = "abcdefghijklmnopqrstuvwxyz";
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

/**
 * The client object. Filled with the host's "get-info" reply once it arrives and extended by the modules.
 * Modules import it from here; it is never exposed as window.kute.
 *
 * @type {Kute}
 */
export const kute = /** @type {Kute} */ ({});

/**
 * Resolves once the host answered "get-info", i.e. once settings, version and launch args are available.
 *
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
            resolve(kute);
        }
    }

    window.chrome.webview.addEventListener("message", handler);
    window.chrome.webview.postMessage("get-info");
});

// inline handlers in generated HTML can only reach the client through a global,
// so it is registered under a random, non-enumerable name that changes every page load
const globalKey = randomKey(12);
Object.defineProperty(window, globalKey, {
    value: kute,
    enumerable: false,
    writable: false,
    configurable: false,
});

/**
 * JS expression that resolves to the client object, for use in inline event handler strings.
 *
 * @type {string}
 */
export const globalRef = `window["${globalKey}"]`;
