/**
 * Opening a private match and spawning into it, the way auto-detect and the HUD editor both need it.
 *
 * Nothing here belongs to a feature: it drives Krunker's own host window the way a player would, and the click
 * that takes the pointer lock comes from the host process, because a DOM click is not trusted enough for it.
 */

/** Burg, the map both features use: small, always available, loads fast. */
const LOBBY_MAP = "gameMap0";

/**
 * @param {number} ms
 * @return {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

/**
 * @return {Partial<KrunkerGameActivity> & {id?: string}}
 */
export function activity(){
    try {
        return window.getGameActivity?.() ?? {};
    }
    catch {
        return {};
    }
}

/**
 * Hosts a private match through Krunker's own host window. The game switches rooms inside the page, so success
 * shows up as a new custom game in the activity, not as a page load.
 *
 * @return {Promise<boolean>}
 */
export async function hostLobby(){
    if (typeof window.openHostWindow !== "function" || typeof window.createPrivateRoom !== "function") return false;
    const previousId = activity().id;
    // the game does not always take the request, for one while the match behind the menu is ending
    for (let attempt = 0; attempt < 4; attempt++){
        window.openHostWindow(false, 0);
        await sleep(800);
        window.windows[7]?.switchTab?.(0);
        await sleep(300);
        const maps = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll("#windowHolder input[id^=gameMap]")]);
        if (maps.length === 0) return false;
        for (const map of maps){
            if (map.checked !== (map.id === LOBBY_MAP)) map.click();
        }
        // a room made by createPrivateRoom is already out of the public game list, but Krunker's own "Private"
        // box is what keeps strangers out. It is ticked for this room only and put back right after: the box
        // holds nothing of its own (no handler, nothing stored) and the room that is running is never read back
        // from the form, the host window only reads it when "Start Game" makes a new room
        const makePrivate = /** @type {HTMLInputElement|null} */ (document.querySelector("#makePrivate"));
        const tickedByUs = !!makePrivate && !makePrivate.checked;
        if (tickedByUs) makePrivate.click();
        const putBack = () => {
            if (tickedByUs) makePrivate.click();
        };

        window.createPrivateRoom();
        for (let i = 0; i < 32; i++){
            await sleep(250);
            const now = activity();
            if (now.custom && now.id && now.id !== previousId && now.map){
                putBack();
                return true;
            }
        }
        putBack();
        window.closWind?.();
        await sleep(1500);
    }
    return false;
}

/**
 * @return {boolean}
 */
export function spawned(){
    const instructions = document.querySelector("#instructions");
    return Boolean(document.pointerLockElement) || (instructions !== null && getComputedStyle(instructions).display === "none");
}

/**
 * Clicks into the match. Pointer lock needs a trusted click, so the host sends it (a DOM click() does nothing).
 *
 * @return {Promise<boolean>}
 */
export async function spawn(){
    for (let i = 0; i < 40 && !(activity().map && document.querySelector("#instructions")); i++) await sleep(250);
    await sleep(500);
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight / 2);
    for (let attempt = 0; attempt < 3 && !spawned(); attempt++){
        window.chrome.webview.postMessage(`click, ${x}, ${y}`);
        await sleep(1200);
    }
    await sleep(800);
    return spawned();
}
