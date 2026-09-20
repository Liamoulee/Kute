import { kute } from "../../client.js";
import { HUD_ELEMENTS } from "./elements.js";

/**
 * Applies the saved HUD layout and opens the editor.
 *
 * The layout is one stylesheet of `translate` and `scale` rules keyed by id. Those two properties compose with
 * `transform` instead of replacing it, so Krunker's own animations on the timer, the ammo box and the streak
 * popups keep working, and a widget the game recreates between rounds is moved again by the same rule. Nothing
 * of this runs per frame: the stylesheet is written once per page load and whenever the editor changes something.
 *
 * Offsets are vw/vh, so a resolution change needs no work, and the editor converts a drag in screen pixels back
 * through the scale Krunker's UI scaling puts on the HUD.
 *
 * @typedef {object} HudPlacement
 * @property {number} [x] Offset to the right, in vw
 * @property {number} [y] Offset down, in vh
 * @property {number} [s] Scale, 1 is untouched
 */

const STYLE_ID = "kute_hudLayoutCSS";

export class HudEditor {
    constructor(){
        /** @type {HTMLStyleElement|null} */
        this.style = null;
        /** @type {boolean} */
        this.open = false;

        kute.hudEditor = { edit: () => this.edit() };

        this.migrateNukeCounter();
        this.apply();

        window.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "F7" || event.repeat || this.open) return;
                if (document.activeElement?.tagName === "INPUT") return;
                event.preventDefault();
                this.edit();
            },
            true,
        );
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
     * Opens the editor. Its code and markup only load when it is actually used.
     */
    edit(){
        if (this.open) return;
        this.open = true;
        import("./editor.js")
            .then((module) => module.openEditor(this))
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
