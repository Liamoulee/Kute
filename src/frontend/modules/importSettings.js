const setHolder = document.createElement("div");
setHolder.classList = "settName";

const settings = {
    Keybinds: localStorage.getItem("kute_Keybinds") === "true" || localStorage.getItem("kute_Keybinds") === null,
    Sensitivity:
        localStorage.getItem("kute_Sensitivity") === "true" || localStorage.getItem("kute_Sensitivity") === null,
    Sound: localStorage.getItem("kute_Sound") === "true" || localStorage.getItem("kute_Sound") === null,
};

let html = "";
for (const setting in settings){
    html += `
	Import ${setting}
<label class="switch">
		<input type="checkbox" onclick="window.localStorage.setItem('kute_${setting}', this.checked)" ${settings[setting] ? "checked" : ""}>
			<span class="slider">
				<span class="grooves">
				</span>
				</span>
	</label>
	<br>`;
}

setHolder.innerHTML = html;
const originalimportSettingsPopup = window.importSettingsPopup;
const originalimportSettings = window.importSettings;

window.importSettingsPopup = () => {
    originalimportSettingsPopup();
    queueMicrotask(() => {
        const importTxtElement = document.querySelector("#importTxt");
        importTxtElement.parentNode.insertBefore(setHolder, importTxtElement.nextSibling);
    });
};

window.importSettings = () => {
    const importTxtElement = document.querySelector("#importTxt");
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
    window.kute.bindShoot();
};
