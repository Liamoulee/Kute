import { kute } from "../../client.js";
import { HUD_ELEMENTS } from "./elements.js";
import { confirmPopup } from "../confirmPopup.js";
import { hostLobby, spawn } from "../privateMatch.js";

/**
 * Applies the saved HUD layout and opens the editor.
 *
 * The layout is one stylesheet of `translate` and `scale` rules keyed by id. Those two properties compose with
 * `transform` instead of replacing it, so Krunker's own animations on the timer, the ammo box and the streak
 * popups keep working, and a widget the game recreates between rounds is moved again by the same rule. Nothing
 * of this runs per frame: the stylesheet is written once per page load and whenever the editor changes something.
 *
 * The editor cannot measure the HUD while it is open: the moment the pointer unlocks, Krunker lays the HUD out
 * for the menu (the FPS counter wraps under the timer, the chat jumps down over the health card). So the geometry
 * comes from a snapshot taken while the player is still in the match, and the editor draws that.
 *
 * @typedef {object} HudPlacement
 * @property {number} [x] Offset to the right, in vw
 * @property {number} [y] Offset down, in vh
 * @property {number} [s] Scale, 1 is untouched
 *
 * @typedef {object} HudGeometry
 * @property {number} vw Viewport the snapshot was taken at
 * @property {number} vh
 * @property {number} factor The scale Krunker's UI scaling had on the HUD
 * @property {Record<string, [number, number, number, number, number]>} rects key -> x, y, width, height, visible
 */

const STYLE_ID = "kute_hudLayoutCSS";
const GEOMETRY_KEY = "kute_hud_geometry";

export class HudEditor {
    constructor(){
        /** @type {HTMLStyleElement|null} */
        this.style = null;
        /** @type {boolean} */
        this.open = false;

        kute.hudEditor = { edit: () => this.edit() };

        this.migrateNukeCounter();
        this.apply();
    }

    /**
     * @return {Record<string, HudPlacement>}
     */
    get layout(){
        return { ...kute.settings.data.hudLayout };
    }

    /**
     * @param {Record<string, HudPlacement>} layout
     */
    save(layout){
        kute.settings.data.hudLayout = layout;
        window.chrome.webview.postMessage(`set-config-json hudLayout ${JSON.stringify(layout)}`);
        this.apply();
    }

    /**
     * The nuke counter carried its own position before the editor existed. Its offsets move into the layout once,
     * relative to where the counter now sits by default (94 % / 50 %), and are dropped from its own setting.
     */
    migrateNukeCounter(){
        const config = kute.settings.data.nukeCounterConfig;
        if (!config || (config.x === undefined && config.y === undefined && config.scale === undefined)) return;

        const { layout } = this;
        layout.nuke ??= {
            x: Math.round(((config.x ?? 94) - 94) * 100) / 100,
            y: Math.round(((config.y ?? 50) - 50) * 100) / 100,
            s: config.scale ?? 1,
        };
        const kept = { goal: config.goal ?? 0, background: config.background ?? true };
        kute.settings.data.nukeCounterConfig = kept;
        window.chrome.webview.postMessage(`set-config-json nukeCounterConfig ${JSON.stringify(kept)}`);
        this.save(layout);
    }

    /**
     * Writes the layout stylesheet.
     */
    apply(){
        const { layout } = this;
        let text = "";
        for (const element of HUD_ELEMENTS){
            const place = layout[element.key];
            if (!place) continue;
            const moved = (place.x ?? 0) !== 0 || (place.y ?? 0) !== 0;
            const scaled = (place.s ?? 1) !== 1;
            if (!moved && !scaled) continue;

            const parts = [];
            if (moved) parts.push(`translate:${place.x ?? 0}vw ${place.y ?? 0}vh`);
            if (scaled) parts.push(`scale:${place.s}`);
            text += `${element.rule ?? element.selector}{${parts.join(";")}}`;
        }

        if (!this.style){
            this.style = document.createElement("style");
            this.style.id = STYLE_ID;
            document.head.append(this.style);
        }
        this.style.textContent = text;
    }

    /**
     * Whether the game is showing the in-match HUD right now, which is the only moment it can be measured.
     *
     * @return {boolean}
     */
    inMatch(){
        const hud = document.querySelector("#inGameUI");
        return !!hud && window.getComputedStyle(hud).display !== "none";
    }

    /**
     * Measures where every widget sits in the match, the ones this mode or a setting hides included, and keeps it
     * for the editor. Runs while the player is still in the match, before anything unlocks the pointer.
     *
     * @return {HudGeometry|null}
     */
    snapshot(){
        if (!this.inMatch()) return null;

        /** @type {{def: import("./elements.js").HudElement, element: HTMLElement, visible: boolean}[]} */
        const found = [];
        for (const def of HUD_ELEMENTS){
            const element = /** @type {HTMLElement|null} */ (document.querySelector(def.selector));
            if (!element) continue;
            found.push({ def, element, visible: window.getComputedStyle(element).display !== "none" });
        }

        /** @type {HudGeometry} */
        const geometry = { vw: window.innerWidth, vh: window.innerHeight, factor: 1, rects: {} };

        // what the player sees, with our own offsets taken out so the snapshot is the untouched layout
        const layoutText = this.style?.textContent ?? "";
        if (this.style) this.style.textContent = "";

        for (const { def, element, visible } of found){
            if (!visible) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0) continue;
            geometry.rects[def.key] = [rect.x, rect.y, rect.width, rect.height, 1];
            // the scale Krunker's UI scaling puts on the HUD, taken off a widget wide enough to be exact
            if (rect.width > 60 && element.offsetWidth > 0) geometry.factor = rect.width / element.offsetWidth;
        }

        // a second pass with the rest forced visible, for whatever this mode or a setting hides
        const hidden = found.filter(({ def }) => !geometry.rects[def.key] && def.display);
        if (hidden.length > 0){
            const probe = document.createElement("style");
            probe.textContent = hidden.map(({ def }) => `${def.selector}{display:${def.display}!important}`).join("");
            document.head.append(probe);
            for (const { def, element } of hidden){
                const rect = element.getBoundingClientRect();
                if (rect.width > 0) geometry.rects[def.key] = [rect.x, rect.y, rect.width, rect.height, 0];
            }
            probe.remove();
        }

        // what is left has no size even when shown (an idle kill feed): its anchor is enough, the editor sizes it
        for (const { def, element } of found){
            if (geometry.rects[def.key]) continue;
            const rect = element.getBoundingClientRect();
            geometry.rects[def.key] = [rect.x, rect.y, rect.width, rect.height, 0];
        }

        if (this.style) this.style.textContent = layoutText;

        try {
            window.localStorage.setItem(GEOMETRY_KEY, JSON.stringify(geometry));
        }
        catch {
            // a full or blocked storage only costs the next editor open its geometry
        }
        return geometry;
    }

    /**
     * The stored snapshot, but only while the window still has the size it was measured at. Krunker anchors its
     * HUD to the screen edges and scales it in steps, so stretching an old snapshot to a new window size puts
     * every box in the wrong place. A different size means measuring again, which is one private match away.
     *
     * @return {HudGeometry|null}
     */
    geometry(){
        if (this.inMatch()) return this.snapshot();

        /** @type {HudGeometry|null} */
        let stored = null;
        try {
            stored = JSON.parse(window.localStorage.getItem(GEOMETRY_KEY) ?? "null");
        }
        catch {
            stored = null;
        }
        if (!stored?.rects) return null;
        if (stored.vw !== window.innerWidth || stored.vh !== window.innerHeight) return null;
        return stored;
    }

    /**
     * Opens the editor. In a match it measures right there, otherwise it offers to open a private match, because
     * the HUD can only be measured while one is on screen.
     *
     * @return {Promise<void>}
     */
    async edit(){
        if (this.open) return;

        if (this.inMatch()){
            this.show(this.snapshot());
            return;
        }

        const go = await confirmPopup({
            title: "Set up your HUD",
            paragraphs: [
                "The editor places everything exactly where it sits in a match, so it needs a match to measure.",
                "Kute opens a private one for you, nobody else can join it. If you are in a game right now, you leave it.",
            ],
            stay: "Not now",
            leave: "Open a private match",
        });
        if (!go || this.open) return;

        if (document.querySelector("#signedInHeaderBar") === null){
            kute.showNotification?.("Log in first, a private match needs an account", false, 5);
            return;
        }

        this.open = true;
        kute.showNotification?.("Opening a private match", false, 4);
        const joined = (await hostLobby()) && (await spawn());
        if (!joined){
            this.open = false;
            kute.showNotification?.("Could not open a private match. Is a host slot free?", false, 6);
            return;
        }

        // the HUD fills in over the first moments of a match (weapons, ammo, the leaderboard row)
        await new Promise((resolve) => {
            setTimeout(resolve, 1500);
        });
        this.open = false;
        this.show(this.snapshot() ?? this.geometry());
    }

    /**
     * Loads the editor and hands it the geometry to draw.
     *
     * @param {HudGeometry|null} geometry
     */
    show(geometry){
        if (!geometry){
            kute.showNotification?.("Could not measure the HUD, try again", false, 6);
            return;
        }
        this.open = true;
        import("./editor.js")
            .then((module) => module.openEditor(this, geometry))
            .catch((error) => {
                this.open = false;
                console.error("[kute] hud editor:", error);
            });
    }

    /**
     * Called by the editor when it closes.
     */
    closed(){
        this.open = false;
    }
}

export default new HudEditor();
