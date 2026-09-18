/**
 * @typedef {object} GameSetting
 * @property {string} id Krunker's setting id
 * @property {string} label
 * @property {string|boolean} cheap The value that costs the least
 * @property {boolean} [needsReload] Krunker only applies it after the page reloads (marked * in its settings), so it cannot be measured inside one test match
 * @property {boolean} [fightOnly] Only costs something while it is on screen (shots, explosions), which an empty test match never shows. Not measured and never changed
 */

/**
 * Ordered by how little a player misses them. The order only breaks ties between equal gains.
 *
 * @type {GameSetting[]}
 */
export const SETTINGS = [
    { id: "postProcessing", label: "Post Processing", cheap: false },
    { id: "shadowsDynamic", label: "Dynamic Shadows", cheap: false },
    { id: "softShad", label: "Soft Shadows", cheap: false, needsReload: true },
    { id: "highResShad", label: "High-Res Shadows", cheap: false, needsReload: true },
    { id: "shadows", label: "Shadows", cheap: false },
    { id: "antiAlias", label: "Antialiasing", cheap: false, needsReload: true },
    { id: "reflection", label: "Reflection Quality", cheap: "1", needsReload: true },
    { id: "lighting", label: "Lighting", cheap: "0", needsReload: true },
    { id: "weaponShine", label: "Weapons Shine", cheap: false },
    { id: "ambientShading", label: "Old Shading", cheap: false },
    { id: "particles", label: "Particles", cheap: false, fightOnly: true },
    { id: "showExplo", label: "Explosions", cheap: false, fightOnly: true },
    { id: "textureAnim", label: "Texture Animations", cheap: false },
    { id: "objectAnim", label: "Object Animations", cheap: false },
    { id: "bulletCasings", label: "Bullet Casings", cheap: false, fightOnly: true },
    { id: "impactHoles", label: "Bullet Impact Holes", cheap: false, fightOnly: true },
    { id: "noPaintAnim", label: "Disable Animated Paints", cheap: true, needsReload: true },
    { id: "mapDet", label: "Map Details", cheap: false, needsReload: true },
    { id: "lowSpec", label: "Low Spec", cheap: true },
];

export const RESOLUTION = "resolution";
export const GAME_FRAME_CAP = "updateRate";

/** Every game setting a run may touch for the undo snapshot. */
export const ALL_IDS = [...SETTINGS.map((setting) => setting.id), RESOLUTION, GAME_FRAME_CAP];

/** @type {Document|null} */
let settingsDocument = null;

/**
 * Krunker only stores a setting once it was changed, so defaults are read from its rendered settings page.
 *
 * @return {Document}
 */
function renderedSettings(){
    if (settingsDocument) return settingsDocument;
    const settingsWindow = window.windows[0];
    const previousTab = settingsWindow.tabIndex;
    const previousType = settingsWindow.settingType;
    let html = "";
    try {
        settingsWindow.settingType = "advanced";
        for (let tab = 0; tab < settingsWindow.tabs.advanced.length - 1; tab++){
            settingsWindow.tabIndex = tab;
            html += settingsWindow.getSettings();
        }
    }
    finally {
        settingsWindow.tabIndex = previousTab;
        settingsWindow.settingType = previousType;
    }
    settingsDocument = new DOMParser().parseFromString(html, "text/html");
    return settingsDocument;
}

/**
 * Forget the parsed settings page, its values are stale after a run.
 */
export function resetCache(){
    settingsDocument = null;
}

/**
 * @param {string} id
 * @return {string|null} The current value as Krunker stores it ("true", "0.5", ...), null when unknown
 */
export function read(id){
    const stored = localStorage.getItem(`kro_setngss_${id}`);
    if (stored !== null) return stored;

    for (const input of renderedSettings().querySelectorAll("input, select")){
        const handler = input.getAttribute("onchange") ?? input.getAttribute("oninput") ?? input.getAttribute("onclick") ?? "";
        if (!handler.includes(`setSetting("${id}"`)) continue;
        const element = /** @type {HTMLInputElement} */ (input);
        return element.type === "checkbox" ? String(element.hasAttribute("checked")) : element.getAttribute("value") ?? element.value;
    }
    return null;
}

/**
 * @param {string} id
 * @param {string|boolean} value
 */
export function write(id, value){
    let typed = value;
    if (value === "true") typed = true;
    else if (value === "false") typed = false;
    window.setSetting(id, typed);
}

/**
 * The value to flip a checkbox setting to for a measurement.
 *
 * @param {string} value
 * @return {string}
 */
export function opposite(value){
    return value === "true" ? "false" : "true";
}
