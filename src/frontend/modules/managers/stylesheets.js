import { kute } from "../../client.js";

/**
 * The exe watches the swapper folder and reports changed swaps itself.
 *
 * @return {boolean}
 */
export const hostWatchesSwapper = () => kute.hostFeatures?.includes("swapper-watch") ?? false;

/**
 * Loads the page's stylesheets for these swapper paths again, so a css swap applies without a refresh.
 *
 * @param {Set<string>} paths lowercased, relative to krunker.io/
 */
export const reloadStylesheets = (paths) => {
    for (const link of document.querySelectorAll("link[rel=\"stylesheet\"]")){
        if (!(link instanceof HTMLLinkElement) || !link.href) continue;
        const url = new URL(link.href);
        if (!/(^|\.)krunker\.io$/.test(url.hostname) || !paths.has(url.pathname.slice(1).toLowerCase())) continue;
        // a new url skips the memory cache, the host ignores the query when it looks up the swap
        url.searchParams.set("kuteSwap", String(Date.now()));
        const fresh = /** @type {HTMLLinkElement} */ (link.cloneNode());
        fresh.href = url.href;
        // the old sheet stays until the new one applied, no unstyled flash
        fresh.addEventListener("load", () => link.remove(), { once: true });
        fresh.addEventListener("error", () => fresh.remove(), { once: true });
        link.after(fresh);
    }
};
