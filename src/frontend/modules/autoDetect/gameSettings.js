/**
 * @typedef {object} GameSetting
 * @property {string} id krunker's setting id
 * @property {string} label
 * @property {string|boolean} cheap the value that costs the least
 * @property {boolean} [needsReload] only applies after a reload (* in krunker's ui), can't be measured
 * @property {boolean} [fightOnly] only costs in a fight, empty test match can't measure it, never changed
 */

/**
 * least missed first, order only breaks ties
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

/**
 * first start baseline, only settings the run can't measure or nobody misses
 *
 * @type {Record<string, string|boolean>}
 */
export const PRESET = {
    // on by default, costs frames and washes the image out
    postProcessing: false,
    // fightOnly
    particles: false,
    showExplo: false,
    bulletCasings: false,
    impactHoles: false,
    // needsReload
    reflection: "1",
    lighting: "0",
    // expensive shadow variants go, shadows stay
    softShad: false,
    highResShad: false,
    noPaintAnim: true,
};

export const RESOLUTION = "resolution";
export const GAME_FRAME_CAP = "updateRate";

export const ALL_IDS = [...SETTINGS.map((setting) => setting.id), RESOLUTION, GAME_FRAME_CAP];

/**
 * @param {string} id
 * @return {string}
 */
export function label(id){
    return SETTINGS.find((setting) => setting.id === id)?.label ?? id;
}

/** @type {Document|null} */
let settingsDocument = null;

/**
 * krunker only stores changed settings, defaults come from its rendered settings page
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

// parsed page is stale after a run
export function resetCache(){
    settingsDocument = null;
}

/**
 * @param {string} id
 * @return {string|null} value as krunker stores it ("true", "0.5", ...), null when unknown
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
 * @param {string} value
 * @return {string}
 */
export function opposite(value){
    return value === "true" ? "false" : "true";
}
