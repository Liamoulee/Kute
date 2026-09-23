import panelHtml from "../../components/kuteIcons.html";
import { kute } from "../../client.js";
import { confirmPopup } from "../confirmPopup.js";
import { SLOTS, postUrls } from "./slots.js";

/**
 * Kute icons: the setting and its customizer.
 *
 * Nothing here writes a Krunker setting on its own. The host answers the icon requests with our images, the page
 * only keeps the host's list of URLs current and lets the player pick the slots. The one exception is asked for:
 * when a ticked icon is hidden by a Krunker setting, the player is offered to switch that setting on.
 *
 * @typedef {import("./slots.js").IconSlot} IconSlot
 * @typedef {import("./slots.js").HidingSetting} HidingSetting
 */

/** Where the host serves our images whatever the toggle says. */
const PREVIEW = "https://krunker.io/kute-icons/";
/** Which slots the player picked, `{kills: false, ...}`. A slot missing from it is on. */
const SLOTS_SETTING = "kuteIconSlots";

/**
 * @return {Record<string, boolean>}
 */
function chosenSlots(){
    const chosen = kute.settings.data[SLOTS_SETTING];
    return chosen && typeof chosen === "object" ? chosen : {};
}

/**
 * @return {boolean} Whether this exe answers the icon requests
 */
function hostSupports(){
    return kute.hostFeatures?.includes("kute-icons") ?? false;
}

/**
 * @param {IconSlot} slot
 * @return {boolean}
 */
function slotOn(slot){
    return chosenSlots()[slot.id] !== false;
}

/**
 * The Krunker settings that currently hide this icon.
 *
 * @param {IconSlot} slot
 * @return {HidingSetting[]}
 */
function hidingSettings(slot){
    return slot.hiddenBy.filter((setting) => {
        let value = null;
        try {
            value = localStorage.getItem(`kro_setngss_${setting.id}`);
        }
        catch {
            return false;
        }
        // never touched means Krunker's default, which shows all of these
        if (value === null) return false;
        return setting.kind === "checkbox" ? value === "false" : Number(value) === 0;
    });
}

/**
 * @param {HidingSetting} setting
 * @return {string}
 */
function describe(setting){
    return setting.kind === "checkbox" ? `${setting.name} is off` : `${setting.name} is 0`;
}

/**
 * Asks before reloading: the game keeps the images it already loaded, so a changed icon only shows after a reload
 * that skips the cache.
 *
 * @param {string} what What changed, one line
 * @return {Promise<void>}
 */
async function offerReload(what){
    const now = await confirmPopup({
        title: "Reload the game?",
        paragraphs: [what, "The game keeps the images it already loaded, so this shows after a reload. Nothing else changes, and you can do it later."],
        stay: "Later",
        leave: "Reload now",
    });
    if (now) window.chrome.webview.postMessage("hard-reload");
}

class KuteIcons {
    constructor(){
        /** @type {boolean} A question is open, so Escape belongs to it and not to the customizer */
        this.asking = false;
        /** @type {WeakSet<Element>} */
        this.watched = new WeakSet();

        kute.kuteIcons = {
            customize: () => this.customize(),
            refresh: () => this.refresh(),
        };
        kute.settings.toggleKuteIcons = (enabled) => this.onToggle(!!enabled);

        this.refresh();
        // the HUD images may only exist once the player spawned
        document.addEventListener("pointerlockchange", () => {
            if (document.pointerLockElement) setTimeout(() => this.refresh(), 1500);
        });
    }

    /**
     * Sends the current URLs and follows the HUD images. The game swaps their sources by itself (a scope skin on
     * the weapon that comes up), so each gets an observer filtered to `src`, which costs nothing until it changes.
     */
    refresh(){
        for (const slot of SLOTS){
            const element = slot.element ? document.getElementById(slot.element) : null;
            if (!element || this.watched.has(element)) continue;
            this.watched.add(element);
            new MutationObserver(() => postUrls()).observe(element, { attributes: true, attributeFilter: ["src"] });
        }
        postUrls();
    }

    /**
     * @param {boolean} enabled
     */
    async onToggle(enabled){
        postUrls();
        // an exe from before Kute icons ignores the setting, so there is nothing to show or reload for
        if (!hostSupports()){
            if (enabled) kute.showNotification("Kute icons need a newer Kute, update the client", false, 4);
            return;
        }
        if (enabled) await this.warnHidden(SLOTS.filter(slotOn));
        await offerReload(enabled ? "Kute icons are on." : "Kute icons are off, your own icons are back.");
    }

    /**
     * Offers to switch on the Krunker settings that hide some of these icons. Nothing is written unless the player
     * says yes.
     *
     * @param {IconSlot[]} slots
     * @return {Promise<boolean>} true when settings were switched on
     */
    async warnHidden(slots){
        /** @type {Map<string, HidingSetting>} */
        const settings = new Map();
        const lines = [];
        for (const slot of slots){
            const hiding = hidingSettings(slot);
            if (hiding.length === 0) continue;
            for (const setting of hiding) settings.set(setting.id, setting);
            lines.push(`${slot.name}: ${hiding.map((setting) => describe(setting)).join(", ")}`);
        }
        if (lines.length === 0) return false;

        this.asking = true;
        const turnOn = await confirmPopup({
            title: "Hidden by your Krunker settings",
            paragraphs: [
                lines.length === 1 ? "This Kute icon will not show:" : "These Kute icons will not show:",
                ...lines,
                "Switch those Krunker settings on for you?",
            ],
            stay: "Leave them",
            leave: "Switch on",
        }).finally(() => {
            this.asking = false;
        });
        if (!turnOn) return false;

        // the same values the settings window writes: a checkbox as a boolean, a slider as a string
        for (const setting of settings.values()) window.setSetting(setting.id, setting.kind === "checkbox" ? true : "1");
        kute.showNotification("Switched on in your Krunker settings", false, 3);
        return true;
    }

    /**
     * One row per icon: preview, name, why it is hidden (with a way to fix that), and its checkbox.
     */
    customize(){
        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = panelHtml;

        /**
         * @param {string} id
         * @return {HTMLElement}
         */
        const element = (id) => /** @type {HTMLElement} */ (shadow.querySelector(`#${id}`));

        const supported = hostSupports();
        const on = kute.settings.data.kuteIcons === true;
        let hint = "Ticked icons show Kute's version. Your Krunker settings stay as they are.";
        if (!on) hint = "Use Kute Icons is off, so none of these show yet.";
        if (!supported) hint = "This needs a newer Kute. Update the client to use Kute icons.";
        element("kiHint").textContent = hint;

        let changed = false;
        /** @type {{slot: IconSlot, box: HTMLInputElement, note: HTMLElement}[]} */
        const rows = [];

        const renderNotes = () => {
            for (const { slot, box, note } of rows){
                const hiding = box.checked ? hidingSettings(slot) : [];
                note.replaceChildren();
                if (hiding.length === 0) continue;
                note.append(`Hidden: ${hiding.map((setting) => describe(setting)).join(", ")} `);
                const show = document.createElement("span");
                show.className = "kiShow";
                show.textContent = "Show it";
                show.onclick = async(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    await this.warnHidden([slot]);
                    renderNotes();
                };
                note.append(show);
            }
        };

        /**
         * @param {IconSlot} slot
         * @param {boolean} value
         */
        const choose = (slot, value) => {
            changed = true;
            const chosen = { ...chosenSlots(), [slot.id]: value };
            kute.settings.data[SLOTS_SETTING] = chosen;
            window.chrome.webview.postMessage(`set-config-json ${SLOTS_SETTING} ${JSON.stringify(chosen)}`);
        };

        for (const slot of SLOTS){
            const row = document.createElement("label");
            row.className = "kiRow";
            const image = document.createElement("img");
            image.src = PREVIEW + slot.file;
            image.alt = "";
            const name = document.createElement("span");
            name.textContent = slot.name;
            const note = document.createElement("span");
            note.className = "kiHidden";
            name.append(note);
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = slotOn(slot);
            box.onchange = async() => {
                choose(slot, box.checked);
                if (box.checked) await this.warnHidden([slot]);
                renderNotes();
            };
            row.append(image, name, box);
            element("kiRows").append(row);
            rows.push({ slot, box, note });
        }
        renderNotes();

        element("kiAll").onclick = async() => {
            const ticked = rows.filter(({ box }) => !box.checked);
            for (const { slot, box } of ticked){
                box.checked = true;
                choose(slot, true);
            }
            await this.warnHidden(ticked.map(({ slot }) => slot));
            renderNotes();
        };

        const controller = new AbortController();
        const close = () => {
            controller.abort();
            overlay.remove();
            if (changed && supported && kute.settings.data.kuteIcons === true) offerReload("Your Kute icons changed.");
        };
        element("kiDone").onclick = close;
        overlay.addEventListener("mousedown", (event) => {
            if (event.target === overlay) close();
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape" || this.asking) return;
                event.stopPropagation();
                close();
            },
            { signal: controller.signal, capture: true },
        );
        document.body.append(overlay);
    }
}

export default new KuteIcons();
