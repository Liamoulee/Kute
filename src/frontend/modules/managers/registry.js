import { kute } from "../../client.js";

/**
 * Live userscript state from the runner. Only on window during bundle eval, so import statically.
 * Null on an exe older than the runner, and on exes older than live loading also with userscripts off.
 *
 * @type {Registry|null}
 */
export const registry = /** @type {any} */ (window).__kuteUserscripts ?? null;

/**
 * The exe can compile game scripts into this page after it loaded.
 *
 * @return {boolean}
 */
export const canLoadLive = () => Boolean(registry && kute.hostFeatures?.includes("userscripts-live"));

/**
 * Compiles game scripts from disk into this page. Queued behind the manager's file writes, so send it after them.
 *
 * @param {string[]|null} keys null for every game script
 * @param {boolean} replace swap in the code on disk for scripts already loaded, false only starts them
 * @param {boolean} start start the enabled ones, false while userscripts are off
 */
export const loadScripts = (keys, replace, start) => {
    window.chrome.webview.postMessage(`scripts-load ${JSON.stringify({ ...(keys ? { keys } : {}), replace, start })}`);
};
