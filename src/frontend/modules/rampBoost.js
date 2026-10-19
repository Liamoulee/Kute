import { kute } from "../client.js";

// krunker's keyCode for the wheel in its controls
const SCROLL = "20000";

let active = false;
/** @type {boolean|undefined} a control is bound to the wheel, what the host was last told */
let scrollBound;

/**
 * Switches the host's ramp boost and remembers it for the linux wheel path below
 *
 * @param {boolean} enabled
 */
export function setRampBoost(enabled){
    active = enabled;
    window.chrome.webview.postMessage(`toggle-rboost, ${enabled}`);
}

/**
 * Ramp boost eats every wheel tick. A player who bound a control (a streak, say) to the wheel gets it passed to the
 * game as well. Runs on every pointer lock, which is after any rebind in the controls menu.
 */
export function syncScrollBinds(){
    let bound = false;
    try {
        bound = Object.keys(localStorage).some((key) => key.startsWith("cont_") && localStorage.getItem(key) === SCROLL);
    }
    catch {
        return;
    }
    if (bound === scrollBound) return;
    scrollBound = bound;
    if (kute.hostFeatures?.includes("scroll-binds")) window.chrome.webview.postMessage(`wheel-to-page, ${bound}`);
}

// windows swallows the wheel in the host's input hook and the page never sees it. linux has no such hook: the tick is
// swallowed here, before the game's listeners, and the host sends the space press itself
window.addEventListener("wheel", (event) => {
    if (!active || !document.pointerLockElement || !kute.hostFeatures?.includes("ramp-boost")) return;
    if (!scrollBound){
        event.stopImmediatePropagation();
        event.preventDefault();
    }
    window.chrome.webview.postMessage(`ramp-wheel, ${(event.deltaY || event.deltaX) < 0 ? 1 : -1}`);
}, { capture: true, passive: false });
