import { kute } from "../client.js";
import { getElement } from "../utils.js";

/** @type {HTMLDivElement} */
const setHolder = document.createElement("div");
setHolder.className = "settName";
setHolder.style.cssText = "display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px 12px;margin-top:10px";

/**
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

const SETTINGS_WINDOW = 1;

/**
 * rebuilds the settings window, krunker doesn't after an import (missing rows, e.g. crosshair image field)
 */
function reopenSettings(){
    if (!document.querySelector("#settSearch")) return;
    window.closWind?.(SETTINGS_WINDOW);
    window.showWindow?.(SETTINGS_WINDOW);
}

window.importSettingsPopup = () => {
    originalimportSettingsPopup();
    queueMicrotask(() => {
        getElement("#importTxt").after(setHolder);
    });
};

window.importSettings = () => {
    /** @type {HTMLTextAreaElement} */
    const importTxtElement = getElement("#importTxt");
    const json = JSON.parse(importTxtElement.value);

    // krunker resets missing settings to defaults (except controls), so copy the current ones in
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
    // import may point icon slots at other images
    kute.kuteIcons?.refresh();
    // undo would restore pre-import values
    kute.autoDetect?.dropUndo();
    // first start setup waits for this
    kute.autoDetect?.afterImport();
};
