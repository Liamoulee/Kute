import { kute } from "../client.js";

let active = false;

/**
 * Switches the host's ramp boost and remembers it for the linux wheel path below
 *
 * @param {boolean} enabled
 */
export function setRampBoost(enabled){
    active = enabled;
    window.chrome.webview.postMessage(`toggle-rboost, ${enabled}`);
}

// windows swallows the wheel in the host's input hook and the page never sees it. linux has no such hook: the tick is
// swallowed here, before the game's listeners, and the host sends the space press itself
window.addEventListener("wheel", (event) => {
    if (!active || !document.pointerLockElement || !kute.hostFeatures?.includes("ramp-boost")) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    window.chrome.webview.postMessage(`ramp-wheel, ${(event.deltaY || event.deltaX) < 0 ? 1 : -1}`);
}, { capture: true, passive: false });
