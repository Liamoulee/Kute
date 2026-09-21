import { kute } from "../client.js";
import { getElement } from "../utils.js";

/** @type {HTMLDivElement} */
const setHolder = document.createElement("div");
setHolder.className = "settName";
// two columns: the labels keep the left one, every switch sits in the right one. As one text flow each switch
// sat wherever its label happened to end, so the three of them stood in a staircase
setHolder.style.cssText = "display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px 12px;margin-top:10px";

/**
 * Which setting groups get imported. Stored per group in localStorage as kute_<group>.
 *
 * @type {Record<string, boolean>}
 */
const settings = {
    Keybinds: localStorage.getItem("kute_Keybinds") === "true" || localStorage.getItem("kute_Keybinds") === null,
    Sensitivity:
        localStorage.getItem("kute_Sensitivity") === "true" || localStorage.getItem("kute_Sensitivity") === null,
    Sound: localStorage.getItem("kute_Sound") === "true" || localStorage.getItem("kute_Sound") === null,
};

let html = "";
for (const setting in settings){
    html += `<span>Import ${setting}</span>
		<label class="switch" style="margin: 0">
			<input type="checkbox" onclick="window.localStorage.setItem('kute_${setting}', this.checked)" ${settings[setting] ? "checked" : ""}>
			<span class="slider"><span class="grooves"></span></span>
		</label>`;
}

setHolder.innerHTML = html;
const originalimportSettingsPopup = window.importSettingsPopup;
const originalimportSettings = window.importSettings;

/** Krunker's settings window, the one the import button sits in. */
const SETTINGS_WINDOW = 1;

/**
 * Builds the settings window again after an import.
 *
 * Krunker builds that window once and does not rebuild it when the values change underneath, and which rows a
 * group shows is decided while it is built: with the crosshair type on anything but Image, the crosshair group
 * holds one row. So a player who imports settings that switch the type to Image finds no field to put the image
 * in, until they close the settings and open them again (reported 2026-09-21, with a screenshot of exactly that).
 */
function reopenSettings(){
    if (!document.querySelector("#settSearch")) return;
    window.closWind?.(SETTINGS_WINDOW);
    window.showWindow?.(SETTINGS_WINDOW);
}

/**
 * Wraps Krunker's importSettingsPopup to add the import toggles below the text area.
 */
window.importSettingsPopup = () => {
    originalimportSettingsPopup();
    queueMicrotask(() => {
        getElement("#importTxt").after(setHolder);
    });
};

/**
 * Wraps Krunker's importSettings to keep the current values of the groups that are toggled off.
 */
window.importSettings = () => {
    /** @type {HTMLTextAreaElement} */
    const importTxtElement = getElement("#importTxt");
    const json = JSON.parse(importTxtElement.value);

    // settings fallback to defaults for everything besides controls
    // just keep them
    if (localStorage.getItem("kute_Sensitivity") === "false"){
        json.sensitivityX = localStorage.getItem("kro_setngss_sensitivityX");
        json.sensitivityY = localStorage.getItem("kro_setngss_sensitivityY");
        json.aimSensitivityX = localStorage.getItem("kro_setngss_aimSensitivityX");
        json.aimSensitivityY = localStorage.getItem("kro_setngss_aimSensitivityY");
    }

    if (localStorage.getItem("kute_Sound") === "false"){
        json.sound = localStorage.getItem("kro_setngss_sound");
        json.ambientVolume = localStorage.getItem("kro_setngss_ambientVolume");
        json.dialogueVolume = localStorage.getItem("kro_setngss_dialogueVolume");
        json.micVolume = localStorage.getItem("kro_setngss_micVolume");
        json.voiceVolume = localStorage.getItem("kro_setngss_voiceVolume");
        json.voiceDistance = localStorage.getItem("kro_setngss_voiceDistance");
        json.gunsVolume = localStorage.getItem("kro_setngss_gunsVolume");
        json.playerVolume = localStorage.getItem("kro_setngss_playerVolume");
        json.skinVolume = localStorage.getItem("kro_setngss_skinVolume");
        json.uiVolume = localStorage.getItem("kro_setngss_uiVolume");
        json.assetVolume = localStorage.getItem("kro_setngss_assetVolume");
    }

    if (localStorage.getItem("kute_Keybinds") === "false") delete json.controls;

    importTxtElement.value = JSON.stringify(json);
    originalimportSettings();
    kute.bindShoot();
    reopenSettings();
    // the import may have pointed an icon slot at another image of the player's own
    kute.kuteIcons?.refresh();
    // an auto-detect undo would now restore values from before the import
    kute.autoDetect?.dropUndo();
    // the first start setup offers this import as its settings step, and continues once it went through
    kute.autoDetect?.afterImport();
};
