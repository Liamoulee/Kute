// imported by main.js so it runs before the game asks for the images

/**
 * @typedef {object} HidingSetting
 * @property {string} id
 * @property {string} name as the settings list shows it
 * @property {"checkbox"|"opacity"} kind hides when off / at 0
 */

/**
 * @typedef {object} IconSlot
 * @property {string} id matches the slot in icons.rs
 * @property {string} file
 * @property {string} name
 * @property {string[]} settings krunker settings holding a custom image url
 * @property {string[]} [keys] localStorage keys holding one url (loadout, not a setting)
 * @property {string[]} [lists] localStorage keys holding [[name, url], ...]
 * @property {string} [element] hud image in a match
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
    // loadout: savedReticle/savedScope = equipped url, krk_custRet/krk_custScps = ones added by url
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

/** keeps the map small */
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
 * urls from krunker's `[[name, url], ...]` lists
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

let posted = "";

export function postUrls(){
    /** @type {Record<string, string[]>} */
    const urls = {};
    for (const slot of SLOTS){
        /** @type {string[]} */
        const list = [];
        for (const setting of slot.settings) list.push(stored(`kro_setngss_${setting}`) ?? "");
        for (const key of slot.keys ?? []) list.push(stored(key) ?? "");
        for (const key of slot.lists ?? []) list.push(...listEntries(key));
        // the hud image catches what no setting names, e.g. an equipped skin
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
