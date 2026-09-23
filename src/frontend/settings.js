import cSettings from "../cSettings.json";
import { kute, globalRef } from "./client.js";
import { getElement, getInput, checkCompMode } from "./utils.js";
import { confirmPopup } from "./modules/confirmPopup.js";

/**
 * Shape of an entry in cSettings.json.
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
 * @property {string} [requires] Id of a checkbox setting this one only works with: the control is disabled while
 *     that one is off (the present FPS counter reads the swap chain hook)
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string[]} [options]
 * @property {string} [html] Rendered control, filled in by SettingsManager
 */

/** @type {Map<string, number>} */
const debounceTimers = new Map();

const settings = /** @type {Record<string, SettingOption>} */ (cSettings);

/**
 * Applies a changed setting: updates the UI, runs side effects for special ids, calls the module's
 * toggle function (or imports the module) and persists the value through the host.
 *
 * @param {string} id
 * @param {string|number|boolean} rawValue
 * @param {boolean} slider Whether the change came from a range input (debounced)
 */
/** Set while the player's "no" to the telemetry question is being applied, so it does not get asked twice. */
let telemetryOffConfirmed = false;

kute.settings.changeSetting = (id, rawValue, slider) => {
    if (rawValue === "") return;

    // switching the telemetry off is allowed, but not without hearing us out first
    if (id === "telemetry" && rawValue === false && !telemetryOffConfirmed){
        getInput("#telemetry").checked = true;
        confirmPopup({
            title: "Whoa there, cutie",
            paragraphs: [
                "When we say anonymous telemetry, we literally mean anonymous telemetry.",
                "Nothing except client performance metrics and hardware specs is sent, for example when you use Auto-Detect Best Settings. No account, no IP address, no ids.",
                "If this is off, we are basically blind to how the client performs AND we also do not receive any error reports.",
                "This helps us IMMENSELY to improve the client further. Please please please consider keeping this enabled. Pretty please?",
            ],
            stay: "Okay fine, keep it on",
            leave: "No, I don't wanna help",
        }).then((leave) => {
            if (!leave) return;
            telemetryOffConfirmed = true;
            getInput("#telemetry").checked = false;
            kute.settings.changeSetting("telemetry", false, false);
            telemetryOffConfirmed = false;
        });
        return;
    }
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

    const toggleFunctionName = /** @type {const} */ (`toggle${id.charAt(0).toUpperCase() + id.slice(1)}`);
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
};

/** Marks behind a setting name, the legend in the first folder header explains them. */
const REFRESH_MARK = ' <span style="color: #3244a8" title="Requires Refresh">*</span>';
const RESTART_MARK = ' <span style="color: #eb5656" title="Requires Restart">*</span>';

/**
 * The buttons above the client settings: [label, material icon, color class, inline action].
 *
 * @return {[string, string, string, string][]}
 */
const topButtons = () => {
    /**
     * @param {string} url One of the hosts the exe opens (constants.rs, OPEN_URL_ALLOWED)
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
        /**
         * @param {...any} args
         * @return {string}
         */
        this.settingsWindow.getSettings = (...args) => {
            const original = origGetSettings.call(this.settingsWindow, ...args);
            const ours = this.getCSettings();
            if (!ours) return original;
            // the client settings belong inside the container krunker closes first, so that closer moves behind
            // them instead of being dropped: dropping it left the settings window one `</div>` short, and while
            // a search was open two short, which closes krunker's own boxes early and swallows the rows after them
            const closesFirst = original.startsWith("</div>");
            return (closesFirst ? original.slice("</div>".length) : original) + ours + (closesFirst ? "</div>" : "");
        };

        this.settingsWindow.getCSettings = () => this.getCSettings();
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
        return (setting.name.toLowerCase() || "").includes(query) || (setting.category.toLowerCase() || "").includes(query);
    }

    /**
     * Renders the input control for a single setting.
     *
     * @param {SettingOption} option
     * @return {string}
     */
    generateHtml(option){
        const value = kute.settings.data[option.id];
        // globalRef contains double quotes, which would end the onclick attribute
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
                const required = option.requires ? settings[option.requires] : null;
                if (required && kute.settings.data[required.id] === false){
                    return `<label class='switch' style="opacity: 0.35; cursor: not-allowed" title="Needs ${required.name}, which is off">
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
        // the buttons belong to the client tab itself, not to a search result
        if (!this.settingsWindow.settingSearch){
            tempHTML += `<div class="kuteTopButtons">${topButtons()
                .map(([label, icon, color, action]) => `<div class="kuteTopButton ${color}" onclick="${action.replaceAll('"', "&quot;")}">
                    ${label}<span class="material-icons">${icon}</span></div>`)
                .join("")}</div>`;
        }
        let previousCategory = null;
        // a search that matches nothing of ours must render nothing at all, not an empty box with its closers
        let rendered = false;

        for (const setting of Object.values(settings)){
            // filter first: while searching, the controls of everything that does not match got built for nothing
            if (this.settingsWindow.settingSearch && !this.searchMatches(setting)) continue;

            setting.html = this.generateHtml(setting);

            if (previousCategory !== setting.category){
                if (previousCategory) tempHTML += "</div>";

                // the first folder header explains the marks, like the legend of a map
                const legend = previousCategory === null
                    ? `<span class="kuteLegend">${REFRESH_MARK} Requires refresh ${RESTART_MARK} Requires restart</span>`
                    : "";
                previousCategory = setting.category;
                tempHTML += `<div class='setHed' id="setHed_kute_${setting.category}" onclick='window.windows[0].collapseFolder(this)'>
										<span class='material-icons plusOrMinus'>keyboard_arrow_down</span> ${setting.category}${legend}</div>
										<div class='setBodH' id="setBod_kute_${setting.category}">`;
            }

            rendered = true;
            tempHTML += `<div class='settName' ${setting.description ? `title="${setting.description}"` : ""}>
								${setting.name.replaceAll("{{version}}", kute.version ?? "")}
								${setting.needsRestart ? RESTART_MARK : ""}
								${setting.needsRefresh ? REFRESH_MARK : ""}
								${setting.html}</div>`;
        }

        // closes the open category body and the kuteSettings box, and nothing else: whatever krunker left open
        // is krunker's to close (see the wrapper in init)
        return rendered ? `${tempHTML}</div></div>` : "";
    }
}

export default new SettingsManager();
