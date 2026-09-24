import { kute } from "../../client.js";
import { HUD_ELEMENTS } from "./elements.js";
import { confirmPopup } from "../confirmPopup.js";
import { activity, hostLobby, spawn } from "../privateMatch.js";

/**
 * Geometry is snapshotted in the match, the menu lays the HUD out differently.
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
 * @property {string} game Match it was measured in, skips re-measuring the same one
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
     * In-match HUD visible, the only time it can be measured.
     *
     * @return {boolean}
     */
    inMatch(){
        const hud = document.querySelector("#inGameUI");
        return !!hud && window.getComputedStyle(hud).display !== "none";
    }

    /**
     * Measures every widget (hidden ones too) and stores it. Call before the pointer unlocks.
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
        const geometry = { vw: window.innerWidth, vh: window.innerHeight, factor: 1, game: activity().id ?? "", rects: {} };

        // measure without our own offsets
        const layoutText = this.style?.textContent ?? "";
        if (this.style) this.style.textContent = "";

        for (const { def, element, visible } of found){
            if (!visible) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0) continue;
            geometry.rects[def.key] = [rect.x, rect.y, rect.width, rect.height, 1];
            // krunker's UI scale, from a widget wide enough to be exact
            if (rect.width > 60 && element.offsetWidth > 0) geometry.factor = rect.width / element.offsetWidth;
        }

        // second pass with hidden widgets forced visible
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

        // still zero-size (idle kill feed), anchor is enough
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
            // only costs the next open its geometry
        }
        return geometry;
    }

    /**
     * Stored snapshot, only if the window size still matches (krunker's HUD doesn't scale linearly).
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
     * Offers a private match to measure in when not in one.
     *
     * @return {Promise<void>}
     */
    async edit(){
        if (this.open) return;

        if (this.inMatch()){
            this.show(this.snapshot());
            return;
        }

        // reopened in the same match, reuse the snapshot
        const measured = this.geometry();
        if (measured?.game && measured.game === activity().id){
            this.show(measured);
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
        const room = await hostLobby();
        const joined = room !== null && (await spawn(room));
        if (!joined){
            this.open = false;
            kute.showNotification?.("Could not open a private match. Is a host slot free?", false, 6);
            return;
        }

        // HUD fills in over the first moments of a match
        await new Promise((resolve) => {
            setTimeout(resolve, 1500);
        });
        this.open = false;
        this.show(this.snapshot() ?? this.geometry());
    }

    /**
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

    closed(){
        this.open = false;
    }
}

export default new HudEditor();
