import cSettings from "../../cSettings.json";
import { kute } from "../client.js";
import { playerValues } from "../performance.js";
import { confirmPopup } from "./confirmPopup.js";

/**
 * Kute's own settings as one file: every setting of cSettings.json plus the object settings below (HUD positions,
 * matchmaker filter, hotkeys, ...). Markers the host keeps per PC (nvidiaProfileCreated, lastPosition, ...) are not
 * settings and never travel. Accounts live in their own DPAPI file, they can't leave this PC anyway.
 */

const FORMAT = "kute-settings";
const VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024;
// the host drops a set-config-json message over 16 KB
const MAX_VALUE_CHARS = 16 * 1024;

/** @type {string[]} object settings outside cSettings.json that belong to the player */
const OBJECT_SETTINGS = ["hudLayout", "matchmakerFilter", "hotkeys", "nukeCounterConfig", "customSkyConfig", "kuteIconSlots", "kuteIconUrls"];

/**
 * @typedef {object} SettingDef
 * @property {string} id
 * @property {any} [defaultValue]
 * @property {string} [type]
 * @property {string[]} [options]
 */

/** @type {SettingDef[]} settings with a value, rows that only hold a button have none */
const VALUE_SETTINGS = Object.values(/** @type {Record<string, SettingDef>} */ (cSettings)).filter((setting) => "defaultValue" in setting);

/**
 * @param {string} id
 * @param {any} value
 * @return {boolean} the value fits this setting, anything else in a file is skipped
 */
function acceptable(id, value){
    if (JSON.stringify(value)?.length > MAX_VALUE_CHARS) return false;
    if (OBJECT_SETTINGS.includes(id)) return value === null || (typeof value === "object" && !Array.isArray(value));
    const setting = VALUE_SETTINGS.find((candidate) => candidate.id === id);
    if (!setting || typeof value !== typeof setting.defaultValue) return false;
    if (setting.options && !setting.options.includes(value)) return false;
    return typeof value !== "number" || Number.isFinite(value);
}

/**
 * @return {string} 2026-10-03
 */
function today(){
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

class SettingsTransfer {
    constructor(){
        kute.settingsTransfer = {
            exportFile: () => this.export(),
            importFile: () => this.pick(),
        };
    }

    export(){
        const data = playerValues(kute.settings.data);
        const ids = [...VALUE_SETTINGS.map((setting) => setting.id), ...OBJECT_SETTINGS];
        const settings = Object.fromEntries(ids.filter((id) => data[id] !== undefined).map((id) => [id, data[id]]));
        const file = { format: FORMAT, version: VERSION, kute: kute.version, exported: today(), settings };

        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
        // the host saves downloads silently, into the Downloads folder
        link.download = `kute-settings-${today()}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
        kute.showNotification(`Exported ${Object.keys(settings).length} settings to your Downloads folder`, false, 4);
    }

    pick(){
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.onchange = () => {
            const file = input.files?.[0];
            if (file) this.read(file).catch((error) => console.error("[kute] settings import:", error));
        };
        input.click();
    }

    /**
     * @param {File} file
     */
    async read(file){
        if (file.size > MAX_FILE_BYTES){
            kute.showNotification("That file is too big for a Kute settings file", false, 4);
            return;
        }
        /** @type {any} */
        let parsed = null;
        try {
            parsed = JSON.parse(await file.text());
        }
        catch {
            parsed = null;
        }
        if (parsed?.format !== FORMAT || typeof parsed.settings !== "object" || parsed.settings === null){
            kute.showNotification("That is not a Kute settings file", false, 4);
            return;
        }
        if (typeof parsed.version !== "number" || parsed.version > VERSION){
            kute.showNotification("That file comes from a newer Kute, update first", false, 4);
            return;
        }

        const entries = Object.entries(/** @type {Record<string, any>} */ (parsed.settings)).filter(([id, value]) => acceptable(id, value));
        if (entries.length === 0){
            kute.showNotification("That file holds no settings this Kute knows", false, 4);
            return;
        }
        const from = typeof parsed.kute === "string" ? ` from Kute ${parsed.kute}` : "";
        const confirmed = await confirmPopup({
            title: "Import Kute settings",
            paragraphs: [
                `${entries.length} settings${from} in ${file.name}.`,
                "They replace your client settings, HUD positions, matchmaker filters and hotkeys. Kute restarts to apply them.",
                "Userscripts, swapper files, custom CSS and your own sky images are files in Documents\\kute and are not part of it.",
            ],
            stay: "Cancel",
            leave: "Import and restart",
        });
        if (!confirmed) return;

        for (const [id, value] of entries){
            kute.settings.data[id] = value;
            window.chrome.webview.postMessage(`set-config-json ${id} ${JSON.stringify(value)}`);
        }
        // host settings, performance mode and the restart-only engine switches only apply on a fresh start
        window.chrome.webview.postMessage("restart");
    }
}

export default new SettingsTransfer();
