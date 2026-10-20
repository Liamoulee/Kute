import { kute, ready } from "../client.js";

/**
 * A left click while the pointer is locked reaches the page as F20 (keyCode 131, input.rs), which the bundle keeps in
 * Krunker's alternate shoot slot. A player who put a key or mouse button of their own into that slot keeps it, and the
 * host then lets the click through as a normal mouse button instead (hostFeature left-click-f20). An older exe cannot,
 * there the slot is taken over as before, otherwise the left click would shoot nothing.
 */

const F20 = 131;
const ALT_SLOT = "cont_shoot1Key_alt";
const PRIMARY_SLOT = "cont_shoot1Key";
const FEATURE = "left-click-f20";

/** @type {boolean|undefined} what the host was last told */
let told;

/**
 * @param {string} slot
 * @return {number} -1 is unbound, like krunker stores it
 */
function read(slot){
    return Number(localStorage.getItem(slot) ?? -1);
}

/**
 * @return {boolean}
 */
function altSlotTaken(){
    const alt = read(ALT_SLOT);
    return alt !== -1 && alt !== F20;
}

/**
 * @return {boolean}
 */
export function hostSupports(){
    return kute.hostFeatures?.includes(FEATURE) === true;
}

/**
 * the bundle may take the alternate shoot slot: it is free, or the exe has no other way to shoot on a left click
 *
 * @return {boolean}
 */
export function claimAltShoot(){
    return !altSlotTaken() || !hostSupports();
}

/**
 * before the game reads its binds. a taken slot waits for the host's feature list, the game reads later than that
 */
export function prepareShootBind(){
    if (!altSlotTaken()){
        localStorage.setItem(ALT_SLOT, String(F20));
        return;
    }
    ready.then(() => {
        if (!hostSupports()) localStorage.setItem(ALT_SLOT, String(F20));
    });
}

/**
 * tells the host whether a locked left click is F20 or a mouse button, once per change. runs on every pointer lock,
 * which is after any rebind in the controls menu
 */
export function syncLeftClick(){
    if (!hostSupports()) return;
    const f20 = read(ALT_SLOT) === F20 || read(PRIMARY_SLOT) === F20;
    if (f20 === told) return;
    told = f20;
    window.chrome.webview.postMessage(`left-click-f20, ${f20}`);
}
