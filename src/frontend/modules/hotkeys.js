import html from "../components/hotkeys.html";
import { kute } from "../client.js";
import { hiddenByPerformance } from "../performance.js";

/**
 * Kute's own keys. The host runs the lobby and window actions (hotkeys.rs reads the same `hotkeys` setting), the page
 * runs the matchmaker and the toggles. Krunker still gets every key, so the menu warns when one of its binds uses it.
 */

const HOST_FEATURE = "hotkeys";
// the host sends a left click as F20 while the pointer is locked
const F20 = 131;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph"]);

/**
 * @typedef {object} Binding
 * @property {number} key keyCode, the same as the windows virtual key the host compares
 * @property {boolean} ctrl
 * @property {boolean} alt
 * @property {boolean} shift
 * @property {string} name how the menu shows it
 */

/**
 * @typedef {object} HotkeyAction
 * @property {string} id key in the `hotkeys` setting, host actions must match ACTIONS in hotkeys.rs
 * @property {string} label
 * @property {string} [note]
 * @property {"window"|"toggle"} group
 * @property {Binding|null} fallback null: no key until the player picks one
 * @property {string} [setting] toggles: the checkbox setting it flips
 */

/**
 * @param {number} key
 * @param {string} name
 * @return {Binding}
 */
const plain = (key, name) => ({ key, ctrl: false, alt: false, shift: false, name });

/** @type {HotkeyAction[]} */
const ACTIONS = [
    { id: "newLobby", label: "New lobby", group: "window", fallback: plain(115, "F4") },
    { id: "matchmaker", label: "Matchmaker", note: "new lobby while the Matchmaker setting is off", group: "window", fallback: plain(117, "F6") },
    { id: "reload", label: "Reload", group: "window", fallback: plain(116, "F5") },
    { id: "fullscreen", label: "Fullscreen", group: "window", fallback: plain(122, "F11") },
    { id: "devtools", label: "Developer tools", group: "window", fallback: plain(123, "F12") },
    { id: "toggleSpotify", label: "Spotify overlay", note: "on and off", group: "toggle", fallback: null, setting: "spotifyOverlay" },
    { id: "toggleKeystrokes", label: "Keystrokes", note: "on and off", group: "toggle", fallback: null, setting: "keystrokes" },
];

/**
 * krunker's controls with their defaults (game code, `this.binds`), slots hold a keyCode in
 * localStorage cont_<id> and cont_<id>_alt once changed, -1 is unbound and 10000 up are mouse buttons
 *
 * @type {[string, string, number, number][]} id, label, primary default, alt default
 */
const KRUNKER_BINDS = [
    ["0", "Forward", 87, -1], ["1", "Back", 83, -1], ["2", "Left", 65, -1], ["3", "Right", 68, -1],
    ["jumpKey", "Jump", 32, -1], ["crouchKey", "Crouch", 16, -1], ["reloadKey", "Reload", 82, -1],
    ["swapKey", "Swap weapon", 69, -1], ["primKey", "Primary weapon", 84, -1], ["meleeKey", "Melee", 81, -1],
    ["equipKey", "Equip", 67, -1], ["dropKey", "Drop", 90, -1], ["inspKey", "Inspect", 88, -1],
    ["wepVisKey", "Hide weapon", -1, -1], ["sprayKey", "Spray", 70, -1], ["sprayWheelKey", "Spray wheel", 70, -1],
    ["interactKey", "Interact", 71, -1], ["interactSecKey", "Second interact", 72, -1], ["confirmKey", "Confirm", 75, -1],
    ["resetKey", "Reset", 66, -1], ["resetLastKey", "Reset to last", 78, -1], ["markPositionKey", "Mark position", 10002, -1],
    ["chatKey", "Chat", 13, -1], ["voiceKey", "Voice chat", 86, -1], ["pListKey", "Player list", 18, -1],
    ["sBoardKey", "Scoreboard", 9, -1], ["hidePlayersKey", "Hide players", -1, -1],
    ["kickVoteYKey", "Kick vote yes", 49, -1], ["kickVoteNKey", "Kick vote no", 50, -1],
    ["kpdVoteYKey", "Vote yes", 89, -1], ["kpdVoteNKey", "Vote no", 78, -1], ["kpdVisionKey", "Vision", 187, -1],
    ["specFreeKey", "Spectate free camera", 70, -1], ["specObjKey", "Spectate objective", 72, -1],
    ["specFirstKey", "Spectate first person", 82, -1], ["specNamesKey", "Spectate names", 77, -1],
    ["specMiniMap", "Spectate minimap", 189, -1], ["specFocusKey", "Spectate focus", 190, -1],
    ["propKey", "Prop", 80, -1], ["propRandKey", "Random prop", 77, -1], ["propRotKey", "Rotate prop", 82, -1],
    ["propRotRKey", "Rotate prop back", 78, -1],
    ["18", "Streak 1", 49, -1], ["19", "Streak 2", 50, -1], ["20", "Streak 3", 51, -1],
    ...[0, 1, 2, 3, 4, 5].map((n) => /** @type {[string, string, number, number]} */ ([`taunt${n}`, `Taunt ${n + 1}`, 49 + n, -1])),
    ...["27", "28", "29", "30", "31", "32"].map((id, n) => /** @type {[string, string, number, number]} */ ([id, `Toggle ${n + 1}`, -1, -1])),
    ...["43", "44", "45", "46", "47", "48"].map((id, n) => /** @type {[string, string, number, number]} */ ([id, `Chat message ${n + 1}`, -1, -1])),
];

/**
 * @return {boolean}
 */
function hostSupports(){
    return Boolean(kute.hostFeatures?.includes(HOST_FEATURE));
}

/**
 * @return {Record<string, Binding|null>} every action, a stored null or a missing default means no key
 */
export function bindings(){
    /** @type {Record<string, Binding|null|undefined>} */
    const stored = (hostSupports() && kute.settings.data.hotkeys) || {};
    return Object.fromEntries(ACTIONS.map((action) => [action.id, stored[action.id] ?? (action.id in stored ? null : action.fallback)]));
}

/**
 * @param {KeyboardEvent} event
 * @param {Binding|null} binding
 * @return {boolean}
 */
function same(event, binding){
    return Boolean(binding) && event.keyCode === binding?.key && event.ctrlKey === binding.ctrl && event.altKey === binding.alt && event.shiftKey === binding.shift;
}

/**
 * @param {KeyboardEvent} event
 * @param {string} id
 * @return {boolean}
 */
export function matches(event, id){
    return same(event, bindings()[id] ?? null);
}

/**
 * @param {number} key
 * @return {string[]} labels of krunker's controls on this key
 */
function krunkerUses(key){
    /**
     * @param {string} slot
     * @param {number} fallback
     * @return {number}
     */
    const read = (slot, fallback) => {
        try {
            const value = window.localStorage.getItem(slot);
            return value === null ? fallback : Number(value);
        }
        catch {
            return fallback;
        }
    };
    return KRUNKER_BINDS.filter(([id, , primary, alt]) => read(`cont_${id}`, primary) === key || read(`cont_${id}_alt`, alt) === key).map(([, label]) => label);
}

/** @type {Record<number, string>} */
const KEY_NAMES = {
    8: "Backspace", 9: "Tab", 13: "Enter", 32: "Space", 33: "PageUp", 34: "PageDown", 35: "End", 36: "Home",
    37: "Left", 38: "Up", 39: "Right", 40: "Down", 45: "Insert", 46: "Delete",
};

/**
 * @param {number} keyCode
 * @return {string} for events without a code (a key some tool posted, no scan code)
 */
function codeName(keyCode){
    if ((keyCode >= 48 && keyCode <= 57) || (keyCode >= 65 && keyCode <= 90)) return String.fromCharCode(keyCode);
    if (keyCode >= 96 && keyCode <= 105) return `Num ${keyCode - 96}`;
    if (keyCode >= 112 && keyCode <= 135) return `F${keyCode - 111}`;
    return KEY_NAMES[keyCode] ?? `Key ${keyCode}`;
}

/**
 * @param {KeyboardEvent} event
 * @return {string}
 */
function keyName(event){
    const { code } = event;
    let name = code;
    if (/^Key[A-Z]$/.test(code)) name = code.slice(3);
    else if (/^Digit\d$/.test(code)) name = code.slice(5);
    else if (code.startsWith("Numpad")) name = `Num ${code.slice(6)}`;
    else if (code.startsWith("Arrow")) name = code.slice(5);
    else if (!code) name = codeName(event.keyCode);
    return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", name].filter(Boolean).join("+");
}

/**
 * @param {HotkeyAction} action
 * @param {Binding} binding
 * @param {Record<string, Binding|null>} current
 * @return {string[]} what else reacts to this key
 */
function clashes(action, binding, current){
    /** @type {string[]} */
    const warnings = [];
    const also = ACTIONS.filter((other) => {
        const theirs = current[other.id];
        return other.id !== action.id && theirs !== null && theirs.key === binding.key && theirs.ctrl === binding.ctrl && theirs.alt === binding.alt && theirs.shift === binding.shift;
    });
    if (also.length > 0) warnings.push(`Also bound to Kute's ${also.map((other) => other.label).join(", ")}, pick another key.`);
    const krunker = krunkerUses(binding.key);
    if (krunker.length > 0){
        const more = krunker.length > 3 ? ` and ${krunker.length - 3} more` : "";
        warnings.push(`Krunker uses this key for ${krunker.slice(0, 3).join(", ")}${more}, the game still gets it.`);
    }
    return warnings;
}

/**
 * @return {boolean} the player is typing (chat, a search field), keys are text then
 */
function typing(){
    const active = document.activeElement;
    return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable);
}

class HotkeyMenu {
    /**
     * @param {Hotkeys} owner
     */
    constructor(owner){
        this.owner = owner;
        /** @type {string|null} action waiting for its new key */
        this.waiting = null;
        this.overlay = document.createElement("div");
        this.overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        this.overlay.append(host);
        this.shadow = host.attachShadow({ mode: "open" });
        this.shadow.innerHTML = html;
        document.body.append(this.overlay);

        this.onKey = this.onKey.bind(this);
        window.addEventListener("keydown", this.onKey, true);
        this.overlay.addEventListener("click", (event) => {
            if (event.target === this.overlay) this.close();
        });
        this.element("hkDone").onclick = () => this.close();
        this.element("hkReset").onclick = () => {
            this.owner.save({});
            this.stopWaiting();
            this.render();
        };
        this.render();
    }

    /**
     * @param {string} id
     * @return {HTMLElement}
     */
    element(id){
        return /** @type {HTMLElement} */ (this.shadow.querySelector(`#${id}`));
    }

    /**
     * @param {string} id
     */
    startWaiting(id){
        this.stopWaiting();
        this.waiting = id;
        this.owner.capturing = true;
        window.chrome.webview.postMessage("hotkeys-pause, true");
        this.render();
    }

    stopWaiting(){
        if (this.waiting === null) return;
        this.waiting = null;
        this.owner.capturing = false;
        window.chrome.webview.postMessage("hotkeys-pause, false");
        this.render();
    }

    /**
     * @param {string} id
     * @param {Binding|null} binding
     */
    assign(id, binding){
        this.owner.save({ ...bindings(), [id]: binding });
        this.stopWaiting();
        this.render();
    }

    /**
     * @param {HotkeyAction} action
     * @param {Record<string, Binding|null>} current
     * @return {HTMLElement}
     */
    row(action, current){
        const binding = current[action.id];
        const row = document.createElement("div");
        row.className = "hkRow";

        const label = document.createElement("div");
        label.className = "hkLabel";
        label.textContent = action.label;
        if (action.note){
            const note = document.createElement("span");
            note.className = "hkNote";
            note.textContent = action.note;
            label.append(note);
        }

        const waiting = this.waiting === action.id;
        const key = document.createElement("div");
        key.className = `hkKey${waiting ? " hkWaiting" : ""}${binding ? "" : " hkNone"}`;
        key.textContent = waiting ? "Press a key" : binding?.name ?? "No key";
        key.title = "Click, then press the new key. Escape cancels";
        key.onclick = () => this.startWaiting(action.id);

        const clear = document.createElement("div");
        clear.className = "hkClear";
        clear.textContent = "Clear";
        clear.style.visibility = binding ? "" : "hidden";
        clear.onclick = () => this.assign(action.id, null);
        row.append(label, key, clear);

        const warnings = binding ? clashes(action, binding, current) : [];
        if (warnings.length === 0) return row;
        const warning = document.createElement("div");
        warning.className = "hkWarn";
        warning.textContent = warnings.join(" ");
        const wrap = document.createElement("div");
        wrap.append(row, warning);
        return wrap;
    }

    render(){
        const current = bindings();
        for (const group of ["window", "toggle"]){
            const rows = ACTIONS.filter((action) => action.group === group).map((action) => this.row(action, current));
            this.element(`hkGroup-${group}`).replaceChildren(...rows);
        }
    }

    /**
     * @param {KeyboardEvent} event
     */
    onKey(event){
        if (this.waiting === null){
            if (event.key === "Escape") this.close();
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "Escape"){
            this.stopWaiting();
            return;
        }
        // wait for the key a modifier is held for
        if (MODIFIER_KEYS.has(event.key) || event.keyCode === F20 || event.keyCode === 0) return;
        this.assign(this.waiting, { key: event.keyCode, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, name: keyName(event) });
    }

    close(){
        this.stopWaiting();
        window.removeEventListener("keydown", this.onKey, true);
        this.overlay.remove();
    }
}

class Hotkeys {
    constructor(){
        this.capturing = false;
        kute.hotkeys = { edit: () => this.edit() };
        window.addEventListener("keydown", (event) => this.onKey(event), true);
    }

    /**
     * the page's own actions, the host runs the window ones
     *
     * @param {KeyboardEvent} event
     */
    onKey(event){
        if (this.capturing || event.repeat || typing() || !hostSupports()) return;
        const current = bindings();
        for (const action of ACTIONS){
            if (action.group !== "toggle" || !action.setting || !same(event, current[action.id])) continue;
            this.flip(action.setting, action.label);
        }
    }

    /**
     * @param {string} setting
     * @param {string} label
     */
    flip(setting, label){
        if (hiddenByPerformance(kute.settings.data, setting)){
            kute.showNotification(`${label} is off in performance mode`, false, 3);
            return;
        }
        const on = !kute.settings.data[setting];
        kute.settings.changeSetting(setting, on, false);
        kute.showNotification(`${label} ${on ? "on" : "off"}`, false, 2);
    }

    /**
     * @param {Record<string, Binding|null>} next
     */
    save(next){
        kute.settings.data.hotkeys = next;
        window.chrome.webview.postMessage(`set-config-json hotkeys ${JSON.stringify(next)}`);
    }

    edit(){
        if (!hostSupports()){
            kute.showNotification("Hotkeys need a newer Kute", false, 3);
            return;
        }
        // eslint-disable-next-line no-new
        new HotkeyMenu(this);
    }
}

export default new Hotkeys();
