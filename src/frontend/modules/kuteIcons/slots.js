/**
 * Kute icons: which icons there are, and which URLs the game may ask for in each of them.
 *
 * The host answers those requests with our images (`src/modules/icons.rs` holds the game's own assets per slot).
 * What the player pointed a slot at themselves is only readable here, so this file sends it over as `icon-urls`.
 * It is small and imported by main.js on purpose: it runs before any page script, so the host knows these URLs
 * before the game asks for the images.
 */

/**
 * A Krunker setting that can hide an icon.
 *
 * @typedef {object} HidingSetting
 * @property {string} id
 * @property {string} name As the settings list shows it
 * @property {"checkbox"|"opacity"} kind A checkbox hides it when off, an opacity at 0
 */

/**
 * @typedef {object} IconSlot
 * @property {string} id Matches the slot in icons.rs
 * @property {string} file
 * @property {string} name
 * @property {string[]} settings Krunker settings holding an image URL of the player's own
 * @property {string[]} [keys] Plain localStorage keys holding one URL (the loadout, which is not a setting)
 * @property {string[]} [lists] Plain localStorage keys holding [[name, url], ...]
 * @property {string} [element] The HUD image that shows it in a match
 * @property {HidingSetting[]} hiddenBy
 */

/** @type {HidingSetting} */
const SHOW_UI = { id: "showUI", name: "Show UI", kind: "checkbox" };

/** @type {IconSlot[]} */
export const SLOTS = [
    {
        id: "kills",
        file: "kills.png",
        name: "Kill counter",
        settings: ["customKills"],
        element: "killsIcon",
        hiddenBy: [SHOW_UI, { id: "showKillC", name: "Show Kill Counter", kind: "checkbox" }],
    },
    {
        id: "deaths",
        file: "deaths.png",
        name: "Death counter",
        settings: ["customDeaths"],
        element: "deathsIcon",
        hiddenBy: [SHOW_UI, { id: "showDeaths", name: "Show Death Counter", kind: "checkbox" }],
    },
    {
        id: "streak",
        file: "streak.png",
        name: "Streak counter",
        settings: ["customStreak"],
        element: "streakIcon",
        hiddenBy: [SHOW_UI, { id: "showStreak", name: "Show Streak Counter", kind: "checkbox" }],
    },
    {
        id: "kdr",
        file: "kdr.png",
        name: "K/D counter",
        settings: [],
        element: "kdIcon",
        hiddenBy: [SHOW_UI, { id: "showKD", name: "Show K/D Counter", kind: "checkbox" }],
    },
    { id: "ammo", file: "ammo.png", name: "Ammo", settings: ["customAmmo"], element: "ammoIcon", hiddenBy: [SHOW_UI] },
    {
        id: "hitmarker",
        file: "hitmarker.png",
        name: "Hitmarker",
        settings: ["customHitmarker"],
        hiddenBy: [
            { id: "hitm", name: "Hitmarker: Show", kind: "checkbox" },
            { id: "hitOpac", name: "Hitmarker: Opacity", kind: "opacity" },
        ],
    },
    // the reticle and the scope live in the loadout: "savedReticle"/"savedScope" hold the equipped URL and
    // krk_custRet/krk_custScps the ones the player added by URL
    { id: "reticle", file: "reticle.png", name: "Reticle", settings: [], keys: ["savedReticle"], lists: ["krk_custRet"], element: "aimDot", hiddenBy: [] },
    {
        id: "scope",
        file: "scope.png",
        name: "Scope",
        settings: [],
        keys: ["savedScope"],
        lists: ["krk_custScps"],
        element: "recticleImg",
        hiddenBy: [{ id: "scopeOpac", name: "Scope Opacity", kind: "opacity" }],
    },
];

/** How many entries of one loadout list are taken, so the map stays small. */
const LIST_LIMIT = 30;

/**
 * @param {string} key
 * @return {string|null}
 */
function stored(key){
    try {
        return localStorage.getItem(key);
    }
    catch {
        return null;
    }
}

/**
 * The URLs in one of Krunker's `[[name, url], ...]` lists.
 *
 * @param {string} key
 * @return {string[]}
 */
function listEntries(key){
    try {
        /** @type {unknown} */
        const entries = JSON.parse(stored(key) ?? "[]");
        if (!Array.isArray(entries)) return [];
        return entries.map((entry) => (Array.isArray(entry) ? entry[1] : null)).filter((url) => typeof url === "string").slice(0, LIST_LIMIT);
    }
    catch {
        return [];
    }
}

/** The last map sent, so nothing is sent twice. */
let posted = "";

/**
 * Tells the host which URLs belong to which slot. Only sends when something changed.
 */
export function postUrls(){
    /** @type {Record<string, string[]>} */
    const urls = {};
    for (const slot of SLOTS){
        /** @type {string[]} */
        const list = [];
        for (const setting of slot.settings) list.push(stored(`kro_setngss_${setting}`) ?? "");
        for (const key of slot.keys ?? []) list.push(stored(key) ?? "");
        for (const key of slot.lists ?? []) list.push(...listEntries(key));
        // what the HUD really shows covers what no setting names, an equipped skin for one
        const element = slot.element ? document.getElementById(slot.element) : null;
        if (element instanceof HTMLImageElement) list.push(element.src);
        const theirs = [...new Set(list)].filter((url) => url.startsWith("http"));
        if (theirs.length > 0) urls[slot.id] = theirs;
    }
    const json = JSON.stringify(urls);
    if (json === posted) return;
    posted = json;
    window.chrome.webview.postMessage(`icon-urls ${json}`);
}
