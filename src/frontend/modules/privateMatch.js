/** burg: small, always there, loads fast */
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
 * still in the hostLobby() room? check before acting, it can turn into a redirect or public game
 *
 * @param {string|null} room
 * @return {boolean}
 */
export function inRoom(room){
    const now = activity();
    return Boolean(room) && Boolean(now.custom) && now.id === room;
}

/**
 * success shows up in the activity, not as a page load
 *
 * @return {Promise<string|null>} room id, null if it failed or the "Private" box is missing
 */
export async function hostLobby(){
    if (typeof window.openHostWindow !== "function" || typeof window.createPrivateRoom !== "function") return null;
    const previousId = activity().id;
    // the game doesn't always take it, e.g. while the match behind the menu ends
    for (let attempt = 0; attempt < 4; attempt++){
        window.openHostWindow(false, 0);
        await sleep(800);
        window.windows[7]?.switchTab?.(0);
        await sleep(300);
        const maps = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll("#windowHolder input[id^=gameMap]")]);
        const makePrivate = /** @type {HTMLInputElement|null} */ (document.querySelector("#makePrivate"));
        // no box = krunker changed something, better no match than a public one
        if (maps.length === 0 || !makePrivate){
            window.closWind?.();
            return null;
        }
        for (const map of maps){
            if (map.checked !== (map.id === LOBBY_MAP)) map.click();
        }
        // "Private" keeps strangers out. ticked for this room only, then put back (the box stores nothing)
        const tickedByUs = !makePrivate.checked;
        if (tickedByUs) makePrivate.click();
        try {
            window.createPrivateRoom();
            for (let i = 0; i < 32; i++){
                await sleep(250);
                const now = activity();
                if (now.custom && now.id && now.id !== previousId && now.map) return now.id;
            }
        }
        finally {
            if (tickedByUs && makePrivate.checked) makePrivate.click();
        }
        window.closWind?.();
        await sleep(1500);
    }
    return null;
}

/**
 * @return {boolean}
 */
export function spawned(){
    const instructions = document.querySelector("#instructions");
    return Boolean(document.pointerLockElement) || (instructions !== null && getComputedStyle(instructions).display === "none");
}

/**
 * pointer lock needs a trusted click, so the host sends it. checks the room first, never spawn in public
 *
 * @param {string|null} room from hostLobby()
 * @return {Promise<boolean>}
 */
export async function spawn(room){
    for (let i = 0; i < 40 && !(activity().map && document.querySelector("#instructions")); i++) await sleep(250);
    await sleep(500);
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight / 2);
    for (let attempt = 0; attempt < 3 && !spawned(); attempt++){
        if (!inRoom(room)) return false;
        window.chrome.webview.postMessage(`click, ${x}, ${y}`);
        await sleep(1200);
    }
    await sleep(800);
    return spawned();
}
