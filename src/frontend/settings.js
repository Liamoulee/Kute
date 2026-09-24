import cSettings from "../cSettings.json";
import { kute, globalRef } from "./client.js";
import { getElement, getInput, checkCompMode } from "./utils.js";

/**
 * a cSettings.json entry
 *
 * @typedef {object} SettingOption
 * @property {string} id
 * @property {string} name "{{version}}" is replaced with the client version
 * @property {string} type "checkbox", "slider", "select" or "none"
 * @property {string} category
 * @property {string|number|boolean} [defaultValue] Absent for button-only settings
 * @property {string} [description]
 * @property {boolean} [needsRestart]
 * @property {boolean} [needsRefresh]
 * @property {string} [button]
 * @property {string} [buttonAction] Inline JS; "{{kute}}" is replaced with a reference to the client object
 * @property {boolean} [requiresLogin] The button is disabled while no account is logged in
 * @property {string} [requires] id of a checkbox setting this one depends on, disabled while that is off
 * @property {string} [disabledBy] id of a checkbox setting that forces this one off while on, the stored value stays
 * @property {string} [hostFeature] hostFeatures entry the exe must list, the setting is not shown without it
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string[]} [options]
 * @property {string} [html] Rendered control, filled in by SettingsManager
 */

/** @type {Map<string, number>} */
const debounceTimers = new Map();

const BLOCKED_STYLE = "opacity: 0.35; cursor: not-allowed";

const settings = /** @type {Record<string, SettingOption>} */ (cSettings);

/**
 * @param {string} id
 * @return {`toggle${string}`}
 */
function toggleName(id){
    return `toggle${id.charAt(0).toUpperCase() + id.slice(1)}`;
}

/**
 * @param {SettingOption} option
 * @return {SettingOption|null} the setting that currently forces this one off
 */
function blockerOf(option){
    const blocker = option.disabledBy ? settings[option.disabledBy] : null;
    return blocker && kute.settings.data[blocker.id] === true ? blocker : null;
}

/**
 * Shows the settings that `id` blocks as off (or their stored value again) and switches their modules to match.
 *
 * @param {string} id
 * @param {boolean} blocking
 */
function applyBlocker(id, blocking){
    for (const dependent of Object.values(settings)){
        if (dependent.disabledBy !== id) continue;
        const on = !blocking && Boolean(kute.settings.data[dependent.id]);

        const input = document.querySelector(`#${dependent.id}`);
        if (input instanceof HTMLInputElement){
            input.checked = on;
            input.disabled = blocking;
            const label = input.closest("label");
            if (label){
                label.style.cssText = blocking ? BLOCKED_STYLE : "";
                label.title = blocking ? `Off while ${settings[id].name} is on` : "";
            }
        }

        const toggle = kute.settings[toggleName(dependent.id)];
        if (typeof toggle === "function") toggle(on);
        else if (on) import(`./modules/${dependent.id}.js`).catch(() => {});
    }
}

/**
 * @param {string} id
 * @param {string|number|boolean} rawValue
 * @param {boolean} slider from a range input, gets debounced
 */
kute.settings.changeSetting = (id, rawValue, slider) => {
    if (rawValue === "") return;

    getInput(`#${id}`).value = String(rawValue);
    let value = rawValue;

    if (typeof value === "string"){
        const numberRegex = /^-?\d*\.?\d+$/;
        if (numberRegex.test(value)){
            if (value.includes(".")) value = Number.parseFloat(value);
            else value = Number.parseInt(value, 10);
        }
    }

    const sliderInput = /** @type {HTMLInputElement|null} */ (document.querySelector(`#slid_input_${id}`));
    if (sliderInput && slider){
        sliderInput.value = String(value);

        clearTimeout(debounceTimers.get(id));

        debounceTimers.set(id, setTimeout(() => {
            kute.settings.data[id] = value;
            window.chrome.webview.postMessage(`set-config, ${id}, ${value}`);

            debounceTimers.delete(id);
        }, 500));
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
                getInput("#obsCapturePlugin").checked = false;
                return;
            }
            window.chrome.webview.postMessage(`obs-plugin, ${value}`);
            break;
        case "rampBoost":
            if (value){
                if (!checkCompMode()) window.chrome.webview.postMessage("toggle-rboost, true");
            }
            else window.chrome.webview.postMessage("toggle-rboost, false");
            break;
        case "exitButton":
            getElement("#clientExit").style.display = `${value ? "flex" : "none"}`;
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
                textSelectCSS.id = "kute_textSelectCSS";
                textSelectCSS.textContent = "#chatHolder * { user-select: text }";
                document.head.append(textSelectCSS);
            }
            else {
                document.querySelector("#kute_textSelectCSS")?.remove();
            }
            break;
        }
        default:
            break;
    }

    const toggleFunctionName = toggleName(id);
    if (typeof kute.settings[toggleFunctionName] !== "function"){
        try {
            import(`./modules/${id}.js`).catch(() => {});
        }
        catch {
            // no module for this setting
        }
    }
    else {
        kute.settings[toggleFunctionName](value);
    }

    kute.settings.data[id] = value;
    window.chrome.webview.postMessage(`set-config, ${id}, ${value}`);
    applyBlocker(id, value === true);
};

const REFRESH_MARK = ' <span style="color: #3244a8" title="Requires Refresh">*</span>';
const RESTART_MARK = ' <span style="color: #eb5656" title="Requires Restart">*</span>';

/**
 * [label, material icon, color class, inline action]
 *
 * @return {[string, string, string, string][]}
 */
const topButtons = () => {
    /**
     * @param {string} url must be under OPEN_URL_ALLOWED (constants.rs), the host drops anything else
     * @return {string}
     */
    const openUrl = (url) => `window.chrome.webview.postMessage('open-url, ${url}')`;
    return [
        ["About", "info", "kuteTopBlue", `${globalRef}.showAboutPopup()`],
        ["Website", "language", "kuteTopBlue", openUrl("https://kute.lol")],
        ["Source Code", "code", "kuteTopPink", openUrl("https://github.com/NullDev/Kute")],
        ["Report Issue", "bug_report", "kuteTopPink", openUrl("https://github.com/NullDev/Kute/issues/choose")],
        ["Manage Swapper", "swap_horiz", "kuteTopOrange", `${globalRef}.swapperManager.open()`],
        ["Manage Userscripts", "extension", "kuteTopOrange", `${globalRef}.userscriptManager.open()`],
    ];
};

class SettingsManager {
    constructor(){
        /** @type {any} krunker's settings window */
        this.settingsWindow = window.windows[0];
        this.init();
    }
    init(){
        const origGetSettings = this.settingsWindow.getSettings;
        /**
         * @param {...any} args
         * @return {string}
         */
        this.settingsWindow.getSettings = (...args) => {
            const original = origGetSettings.call(this.settingsWindow, ...args);
            const ours = this.getCSettings();
            if (!ours) return original;
            // our settings go inside krunker's first closing div, so move that closer behind them
            const closesFirst = original.startsWith("</div>");
            return (closesFirst ? original.slice("</div>".length) : original) + ours + (closesFirst ? "</div>" : "");
        };

        this.settingsWindow.getCSettings = () => this.getCSettings();
        kute.openKuteSettings = () => {
            window.showWindow(1);
            this.settingsWindow.changeTab(this.settingsWindow.tabs[this.settingsWindow.settingType].length - 1);
        };
        window.chrome.webview.addEventListener("message", (event) => {
            const response = event.data;
            if (response?.type !== "obs-plugin") return;
            if (!response.ok){
                kute.settings.data.obsCapturePlugin = false;
                const checkbox = /** @type {HTMLInputElement|null} */ (document.querySelector("#obsCapturePlugin"));
                if (checkbox) checkbox.checked = false;
            }
            kute.showNotification(response.message, false, 5);
        });
    }

    /**
     * @param {SettingOption} setting
     * @return {boolean}
     */
    searchMatches(setting){
        const query = this.settingsWindow.settingSearch.toLowerCase() || "";
        return [setting.name, setting.category, setting.description ?? ""].some((text) => text.toLowerCase().includes(query));
    }

    /**
     * @param {SettingOption} option
     * @return {string}
     */
    generateHtml(option){
        const value = kute.settings.data[option.id];
        // globalRef has double quotes, would end the onclick attribute
        const buttonAction = option.buttonAction?.replaceAll("{{kute}}", globalRef).replaceAll('"', "&quot;") ?? "";
        const locked = option.requiresLogin && document.querySelector("#signedInHeaderBar") === null;
        let button = "";
        if (option.button && locked){
            button = `<div class="settingsBtn" style="margin-right: 20px; width: auto; opacity: 0.35; cursor: not-allowed" title="Log in first">${option.button}</div>`;
        }
        else if (option.button){
            button = `<div class="settingsBtn" style="margin-right: 20px; width: auto" onclick="${buttonAction}">${option.button}</div>`;
        }
        switch (option.type){
            case "checkbox": {
                const blocker = blockerOf(option);
                if (blocker){
                    return `<label class='switch' style="${BLOCKED_STYLE}" title="Off while ${blocker.name} is on">
                        <input id="${option.id}" type='checkbox' disabled
                            onclick='${globalRef}.settings.changeSetting("${option.id}", this.checked, false)'>
                        <span class='slider'></span>
                    </label>
                    ${button}`;
                }
                const required = option.requires ? settings[option.requires] : null;
                if (required && kute.settings.data[required.id] === false){
                    return `<label class='switch' style="${BLOCKED_STYLE}" title="Needs ${required.name}, which is off">
                        <input id="${option.id}" type='checkbox' disabled ${value ? "checked" : ""}>
                        <span class='slider'></span>
                    </label>
                    ${button}`;
                }
                return `<label class='switch'>
                    <input id="${option.id}" type='checkbox'
                        onclick='${globalRef}.settings.changeSetting("${option.id}", this.checked, false)'
                        ${value ? "checked" : ""}>
                    <span class='slider'></span>
                </label>
                ${button}`;
            }
            case "slider":
                return `<input type="number" class="sliderVal" id="slid_input_${option.id}" min="${option.min}" value="${value || option.min}"
                    step="${option.step}" oninput='${globalRef}.settings.changeSetting("${option.id}", this.value, true)' style="margin-right:0px;border-width:0px">
                <div class="slidecontainer" style="margin-top: -8px;"><input type="range" id="${option.id}" min="${option.min}" max="${option.max}"
                    step="${option.step}" value="${value}" class="sliderM" oninput='${globalRef}.settings.changeSetting("${option.id}", this.value, true)'></div>`;
            case "select":
                return `<select id="${option.id}" class="inputGrey2" onchange='${globalRef}.settings.changeSetting("${option.id}", this.value, false)'>
                    ${(option.options ?? []).map((opt) => `<option value="${opt}" ${opt === value ? "selected" : ""}>${opt}</option>`).join("")}</select>`;
            case "none":
                return button;
            default:
                return "";
        }
    }

    /**
     * @return {string}
     */
    getCSettings(){
        if (
            // our tab is the last one in basic mode too
            this.settingsWindow.tabs[this.settingsWindow.settingType].length !== this.settingsWindow.tabIndex + 1 &&
            !this.settingsWindow.settingSearch
        ){
            return "";
        }

        let tempHTML = "<div class='kuteSettings'>";
        if (!this.settingsWindow.settingSearch){
            tempHTML += `<div class="kuteTopButtons">${topButtons()
                .map(([label, icon, color, action]) => `<div class="kuteTopButton ${color}" onclick="${action.replaceAll('"', "&quot;")}">
                    ${label}<span class="material-icons">${icon}</span></div>`)
                .join("")}</div>`;
        }
        let previousCategory = null;
        // empty search result must render nothing, not an empty box
        let rendered = false;

        for (const setting of Object.values(settings)){
            // an exe older than the setting would store the value and ignore it
            if (setting.hostFeature && !kute.hostFeatures?.includes(setting.hostFeature)) continue;
            if (this.settingsWindow.settingSearch && !this.searchMatches(setting)) continue;

            setting.html = this.generateHtml(setting);

            if (previousCategory !== setting.category){
                if (previousCategory) tempHTML += "</div>";

                const legend = previousCategory === null
                    ? `<span class="kuteLegend">${REFRESH_MARK} Requires refresh ${RESTART_MARK} Requires restart</span>`
                    : "";
                previousCategory = setting.category;
                tempHTML += `<div class='setHed' id="setHed_kute_${setting.category}" onclick='window.windows[0].collapseFolder(this)'>
										<span class='material-icons plusOrMinus'>keyboard_arrow_down</span> ${setting.category}${legend}</div>
										<div class='setBodH' id="setBod_kute_${setting.category}">`;
            }

            rendered = true;
            tempHTML += `<div class='settName'>
								${setting.name.replaceAll("{{version}}", kute.version ?? "")}
								${setting.needsRestart ? RESTART_MARK : ""}
								${setting.needsRefresh ? REFRESH_MARK : ""}
								${setting.html}
								${setting.description ? `<div class="kuteDesc">${setting.description.replaceAll("<", "&lt;")}</div>` : ""}</div>`;
        }

        // closes category body and kuteSettings box only, rest is krunker's (see init)
        return rendered ? `${tempHTML}</div></div>` : "";
    }
}

export default new SettingsManager();
