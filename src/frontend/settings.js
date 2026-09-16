import cSettings from "../cSettings.json";

/**
 * Shape of an entry in cSettings.json.
 *
 * @typedef {object} SettingOption
 * @property {string} id
 * @property {string} name
 * @property {"checkbox"|"slider"|"select"|"none"} type
 * @property {string} category
 * @property {string|number|boolean} defaultValue
 * @property {string} [description]
 * @property {boolean} [needsRestart]
 * @property {boolean} [needsRefresh]
 * @property {string} [button]
 * @property {string} [buttonAction]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string[]} [options]
 * @property {string} [html] Rendered control, filled in by SettingsManager
 */

/** @type {Map<string, number>} */
const debounceTimers = new Map();

/**
 * Applies a changed setting: updates the UI, runs side effects for special ids, calls the module's
 * toggle function (or imports the module) and persists the value through the host.
 *
 * @param {string} id
 * @param {string|number|boolean} rawValue
 * @param {boolean} slider Whether the change came from a range input (debounced)
 */
window.kute.settings.changeSetting = (id, rawValue, slider) => {
    if (rawValue === "") return;
    document.querySelector(`#${id}`).value = rawValue;
    let value = rawValue;

    if (typeof value === "string"){
        const numberRegex = /^-?\d*\.?\d+$/;
        if (numberRegex.test(value)){
            if (value.includes(".")) value = Number.parseFloat(value);
            else value = Number.parseInt(value, 10);
        }
    }

    if (document.querySelector(`#slid_input_${id}`) && slider){
        document.querySelector(`#slid_input_${id}`).value = value;

        if (debounceTimers[id]) clearTimeout(debounceTimers[id]);

        debounceTimers[id] = setTimeout(() => {
            window.kute.settings.data[id] = value;
            window.chrome.webview.postMessage(`set-config, ${id}, ${value}`);

            debounceTimers.delete(id);
        }, 500);
        return;
    }

    switch (id){
        case "obsCapturePlugin":
            if (
                value &&
                // eslint-disable-next-line no-alert
                !confirm(
                    "Install the Kute Capture plugin into OBS? OBS must be closed, and Windows may ask for administrator permission.",
                )
            ){
                document.querySelector("#obsCapturePlugin").checked = false;
                return;
            }
            window.chrome.webview.postMessage(`obs-plugin, ${value}`);
            break;
        case "rampBoost":
            if (value){
                if (!window.checkCompMode()) window.chrome.webview.postMessage("toggle-rboost, true");
            }
            else window.chrome.webview.postMessage("toggle-rboost, false");
            break;
        case "exitButton":
            document.querySelector("#clientExit").style.display = `${value ? "flex" : "none"}`;
            break;
        case "menuTimer":
            if (value){
                import("./components/menuTimer.css").then((css) => {
                    const menuTimerCSS = document.createElement("style");
                    menuTimerCSS.id = "kute_menuTimerCSS";
                    menuTimerCSS.textContent = css.default;
                    document.head.append(menuTimerCSS);
                });
            }
            else {
                document.querySelector("#kute_menuTimerCSS")?.remove();
            }
            break;
        case "cleanUI": {
            if (value){
                import("./components/clean.css").then((css) => {
                    const cleanCSS = document.createElement("style");
                    cleanCSS.id = "kute_cleanCSS";
                    cleanCSS.textContent = css.default;
                    document.head.append(cleanCSS);
                });
            }
            else {
                document.querySelector("#kute_cleanCSS")?.remove();
            }
            break;
        }
        case "textSelect": {
            if (value){
                const textSelectCSS = document.createElement("style");
                textSelectCSS.id = "textSelect";
                textSelectCSS.textContent = "#chatHolder * { user-select: text }";
                document.head.append(textSelectCSS);
            }
            else {
                document.querySelector("#textSelect")?.remove();
            }
            break;
        }
        default:
            break;
    }

    const toggleFunctionName = `toggle${id.charAt(0).toUpperCase() + id.slice(1)}`;
    if (typeof window.kute.settings[toggleFunctionName] !== "function"){
        try {
            import(`./modules/${id}.js`);
        }
        catch {
            /*  */
        }
    }
    else {
        window.kute.settings[toggleFunctionName](value);
    }

    window.kute.settings.data[id] = value;
    window.chrome.webview.postMessage(`set-config, ${id}, ${value}`);
};

/**
 * Renders the client settings into Krunker's Advanced settings tab.
 */
class SettingsManager {
    constructor(){
        /** @type {any} Krunker's settings window object */
        this.settingsWindow = window.windows[0];
        this.init();
    }
    /**
     * Hooks Krunker's settings renderer and listens for OBS plugin install results.
     */
    init(){
        const origGetSettings = this.settingsWindow.getSettings;
        this.settingsWindow.getSettings = (...args) =>
            origGetSettings.call(this.settingsWindow, ...args).replace(/^<\/div>/, "") + this.getCSettings();

        this.settingsWindow.getCSettings = () => this.getCSettings();
        window.chrome.webview.addEventListener("message", (event) => {
            const response = event.data;
            if (response?.type !== "obs-plugin") return;
            if (!response.ok){
                window.kute.settings.data.obsCapturePlugin = false;
                const checkbox = document.querySelector("#obsCapturePlugin");
                if (checkbox) checkbox.checked = false;
            }
            window.kute.showNotification(response.message, false, 5);
        });
    }

    /**
     * @param {SettingOption} setting
     * @return {boolean}
     */
    searchMatches(setting){
        const query = this.settingsWindow.settingSearch.toLowerCase() || "";
        return (setting.name.toLowerCase() || "").includes(query) || (setting.category.toLowerCase() || "").includes(query);
    }

    /**
     * Renders the input control for a single setting.
     *
     * @param {SettingOption} option
     * @return {string}
     */
    generateHtml(option){
        const value = window.kute.settings.data[option.id];
        const button = option.button
            ? `<div class="settingsBtn" style="margin-right: 20px; width: auto" onclick="${option.buttonAction}">${option.button}</div>`
            : "";
        switch (option.type){
            case "checkbox":
                return `<label class='switch'>
                    <input id="${option.id}" type='checkbox'
                        onclick='window.kute.settings.changeSetting("${option.id}", this.checked, false)'
                        ${value ? "checked" : ""}>
                    <span class='slider'></span>
                </label>
                ${button}`;
            case "slider":
                return `<input type="number" class="sliderVal" id="slid_input_${option.id}" min="${option.min}" value="${value || option.min}"
                    step="${option.step}" oninput='window.kute.settings.changeSetting("${option.id}", this.value, true)' style="margin-right:0px;border-width:0px">
                <div class="slidecontainer" style="margin-top: -8px;"><input type="range" id="${option.id}" min="${option.min}" max="${option.max}"
                    step="${option.step}" value="${value}" class="sliderM" oninput='window.kute.settings.changeSetting("${option.id}", this.value, true)'></div>`;
            case "select":
                return `<select id="${option.id}" class="inputGrey2" onchange='window.kute.settings.changeSetting("${option.id}", this.value, false)'>
                    ${option.options.map((opt) => `<option value="${opt}" ${opt === value ? "selected" : ""}>${opt}</option>`)}</select>`;
            case "none":
                return button;
            default:
                return "";
        }
    }

    /**
     * Renders all client settings grouped by category, or nothing when another tab is active.
     *
     * @return {string}
     */
    getCSettings(){
        if (
            this.settingsWindow.tabs.advanced.length !== this.settingsWindow.tabIndex + 1 &&
            !this.settingsWindow.settingSearch
        ){
            return "";
        }

        let tempHTML = "<div class='kuteSettings'>";
        let previousCategory = null;

        for (const entry of Object.keys(cSettings)){
            const setting = cSettings[entry];
            setting.html = this.generateHtml(setting);

            if (this.settingsWindow.settingSearch && !this.searchMatches(setting)) continue;

            if (previousCategory !== setting.category){
                if (previousCategory) tempHTML += "</div>";

                previousCategory = setting.category;
                tempHTML += `<div class='setHed' id="setHed_kute_${setting.category}" onclick='window.windows[0].collapseFolder(this)'>
										<span class='material-icons plusOrMinus'>keyboard_arrow_down</span> ${setting.category}</div>
										<div class='setBodH' id="setBod_kute_${setting.category}">`;
            }

            tempHTML += `<div class='settName' ${setting.description ? `title="${setting.description}"` : ""}>
								${setting.name}
								${setting.needsRestart ? ' <span style="color: #eb5656" title="Requires Restart">*</span>' : ""}
								${setting.needsRefresh ? ' <span style="color: #3244a8" title="Requires Refresh">*</span>' : ""}
								${setting.html}</div>`;
        }

        return tempHTML ? `${tempHTML}</div></div></div>` : "";
    }
}

export default new SettingsManager();
