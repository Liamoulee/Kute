import styles from "../../components/hudEditor.css";
import panelHtml from "../../components/hudEditorPanel.html";
import { kute } from "../../client.js";
import { HUD_ELEMENTS, SHOW_UI_SETTING, gameSettingOn } from "./elements.js";

/** How close two edges have to be for a drag to snap, in screen pixels. */
const SNAP_PX = 6;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @return {number}
 */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * @param {number} value
 * @return {number}
 */
const round = (value) => Math.round(value * 100) / 100;

/**
 * @typedef {object} Item
 * @property {import("./elements.js").HudElement} def
 * @property {HTMLElement} element
 * @property {HTMLElement} box
 * @property {boolean} modeOnly True when the game hides it in this mode, without a setting of its own
 */

/**
 * The editor: a transparent overlay of draggable boxes over the real HUD, plus a panel.
 *
 * Krunker's DOM is never touched. The boxes are ours, the widgets move because of the layout stylesheet, and
 * widgets that a setting hides are faded in by a stylesheet that only exists while the editor is open.
 *
 * @param {import("./index.js").HudEditor} hud
 * @return {Promise<void>}
 */
export async function openEditor(hud){
    if (document.pointerLockElement) document.exitPointerLock();

    const { layout } = hud;

    const editorStyle = document.createElement("style");
    editorStyle.id = "kute_hudEditorCSS";
    editorStyle.textContent = styles;
    document.head.append(editorStyle);

    // the widgets a setting hides, faded in so they can be placed too
    const ghostStyle = document.createElement("style");
    ghostStyle.id = "kute_hudGhostCSS";
    document.head.append(ghostStyle);

    document.documentElement.classList.add("kuteHudEdit");
    // the HUD is revealed by a class on <html>, so nothing can be measured before the next frame
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const overlay = document.createElement("div");
    overlay.id = "kuteHudEditor";
    document.body.append(overlay);

    /** @type {Item[]} */
    const items = [];
    for (const def of HUD_ELEMENTS){
        const element = /** @type {HTMLElement|null} */ (document.querySelector(def.selector));
        if (!element) continue;

        const box = document.createElement("div");
        box.className = "hudBox";
        const label = document.createElement("div");
        label.className = "hudLabel";
        label.textContent = def.name;
        box.append(label);
        overlay.append(box);

        // read before any ghost rule exists: a widget without a setting that is hidden belongs to another mode
        const modeOnly = !def.setting && !def.clientSetting && getComputedStyle(element).display === "none";
        items.push({ def, element, box, modeOnly });
    }

    /** @type {HTMLElement[]} */
    const guides = [];
    for (const kind of ["hudGuideV", "hudGuideH"]){
        const guide = document.createElement("div");
        guide.className = `hudGuide ${kind}`;
        guide.style.display = "none";
        overlay.append(guide);
        guides.push(guide);
    }

    /**
     * Whether the widget is on in the game right now.
     *
     * @param {Item} item
     * @return {boolean}
     */
    const shown = ({ def, modeOnly }) => {
        if (def.setting) return gameSettingOn(def.setting);
        if (def.clientSetting) return kute.settings.data[def.clientSetting] !== false;
        return !modeOnly;
    };

    /**
     * Rewrites the stylesheet that fades hidden widgets in.
     */
    const refreshGhosts = () => {
        let text = "";
        for (const item of items){
            if (shown(item)) continue;
            text += `${item.def.selector}{display:${item.def.display ?? "block"}!important;opacity:0.45!important}`;
        }
        ghostStyle.textContent = text;
    };

    // the scale Krunker's UI scaling puts on the HUD, so a drag in screen pixels becomes the right offset
    let globalFactor = 1;

    /**
     * @param {HTMLElement} element
     * @param {number} scale
     * @return {number}
     */
    const factorOf = (element, scale) => {
        const width = element.offsetWidth;
        const rect = element.getBoundingClientRect().width;
        if (!width || !rect) return globalFactor;
        return rect / width / (scale || 1);
    };

    /**
     * Takes the HUD scale off the widest widget that nothing has scaled.
     */
    const measureGlobalFactor = () => {
        for (const item of items){
            if ((layout[item.def.key]?.s ?? 1) !== 1) continue;
            const factor = factorOf(item.element, 1);
            if (item.element.offsetWidth > 40 && factor > 0){
                globalFactor = factor;
                return;
            }
        }
    };

    /**
     * Draws every box over its widget. A widget that is empty right now (an idle kill feed) gets a placeholder
     * box at its anchor, grown towards the middle of the screen so it stays on screen.
     */
    const syncBoxes = () => {
        measureGlobalFactor();
        for (const item of items){
            const { def, element, box } = item;
            const rect = element.getBoundingClientRect();
            let width = Math.max(rect.width, (def.min?.[0] ?? 0) * globalFactor, 24);
            let height = Math.max(rect.height, (def.min?.[1] ?? 0) * globalFactor, 18);
            let left = rect.width >= width || rect.x < window.innerWidth / 2 ? rect.x : rect.x - width;
            let top = rect.height >= height || rect.y < window.innerHeight / 2 ? rect.y : rect.y - height;

            // a widget that is only faded in fills its whole holder when it has no content (the rounds strip
            // spans the top of the screen), which would make a box nobody can miss or avoid
            if (!shown(item) && rect.width > window.innerWidth * 0.4){
                width = Math.max((def.min?.[0] ?? 0) * globalFactor, 120);
                left = rect.x + rect.width / 2 - width / 2;
            }
            if (!shown(item) && rect.height > window.innerHeight * 0.4){
                height = Math.max((def.min?.[1] ?? 0) * globalFactor, 60);
                top = rect.y + rect.height / 2 - height / 2;
            }

            box.style.left = `${Math.round(left)}px`;
            box.style.top = `${Math.round(top)}px`;
            box.style.width = `${Math.round(width)}px`;
            box.style.height = `${Math.round(height)}px`;
            box.classList.toggle("hudOff", !shown(item));
        }
    };

    /**
     * @param {string} key
     * @return {import("./index.js").HudPlacement}
     */
    const placeOf = (key) => (layout[key] ??= {});

    /**
     * Puts the working layout into the client object and repaints the stylesheet. The host only hears about it
     * when the editor closes.
     */
    const applyLive = () => {
        kute.settings.data.hudLayout = layout;
        hud.apply();
    };

    /** @type {Map<string, HTMLElement>} */
    const panelRows = new Map();
    /** @type {Map<string, HTMLInputElement>} */
    const panelChecks = new Map();

    /**
     * Keeps the panel in sync with the layout: what moved, what is on.
     */
    const refreshRows = () => {
        for (const item of items){
            const row = panelRows.get(item.def.key);
            if (!row) continue;
            const place = layout[item.def.key];
            const scale = place?.s ?? 1;
            const changed = !!place && ((place.x ?? 0) !== 0 || (place.y ?? 0) !== 0 || scale !== 1);
            row.classList.toggle("hpChanged", changed);
            const moved = /** @type {HTMLElement|null} */ (row.querySelector(".hpMoved"));
            if (moved) moved.textContent = scale === 1 ? "" : `${Math.round(scale * 100)}%`;
            const check = panelChecks.get(item.def.key);
            if (check) check.checked = shown(item);
        }
    };

    /** @type {Item|null} */
    let selected = null;

    /**
     * Lights a box up while the pointer is over its row.
     *
     * @param {Item} item
     * @param {boolean} on
     */
    const highlight = (item, on) => item.box.classList.toggle("hudActive", on || selected === item);

    /**
     * @param {Item|null} item
     */
    const select = (item) => {
        selected = item;
        for (const other of items) other.box.classList.toggle("hudActive", other === item);
    };

    /**
     * @param {Item} item
     * @param {number} screenX Offset from where the move started, in screen pixels
     * @param {number} screenY
     * @param {import("./index.js").HudPlacement} from The placement when the move started
     */
    const moveTo = (item, screenX, screenY, from) => {
        const place = placeOf(item.def.key);
        const factor = factorOf(item.element, place.s ?? 1) || 1;
        place.x = round((from.x ?? 0) + (screenX / factor / window.innerWidth) * 100);
        place.y = round((from.y ?? 0) + (screenY / factor / window.innerHeight) * 100);
        applyLive();
    };

    /**
     * Snaps a dragged box to the screen edges and centers and to every other box, and draws the guides.
     *
     * @param {Item} item
     * @param {DOMRect} start Where the box was when the drag started
     * @param {number} dx
     * @param {number} dy
     * @return {[number, number]}
     */
    const snap = (item, start, dx, dy) => {
        const verticals = [0, window.innerWidth / 2, window.innerWidth];
        const horizontals = [0, window.innerHeight / 2, window.innerHeight];
        for (const other of items){
            if (other === item) continue;
            const rect = other.box.getBoundingClientRect();
            verticals.push(rect.left, rect.left + rect.width / 2, rect.right);
            horizontals.push(rect.top, rect.top + rect.height / 2, rect.bottom);
        }

        /** @type {{delta: number, at: number}|null} */
        let bestX = null;
        /** @type {{delta: number, at: number}|null} */
        let bestY = null;
        for (const edge of [start.left + dx, start.left + dx + start.width / 2, start.right + dx]){
            for (const target of verticals){
                const delta = target - edge;
                if (Math.abs(delta) <= SNAP_PX && (bestX === null || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, at: target };
            }
        }
        for (const edge of [start.top + dy, start.top + dy + start.height / 2, start.bottom + dy]){
            for (const target of horizontals){
                const delta = target - edge;
                if (Math.abs(delta) <= SNAP_PX && (bestY === null || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, at: target };
            }
        }

        guides[0].style.display = bestX ? "block" : "none";
        if (bestX) guides[0].style.left = `${bestX.at}px`;
        guides[1].style.display = bestY ? "block" : "none";
        if (bestY) guides[1].style.top = `${bestY.at}px`;

        return [dx + (bestX?.delta ?? 0), dy + (bestY?.delta ?? 0)];
    };

    for (const item of items){
        const { box } = item;
        /** @type {{x: number, y: number, rect: DOMRect, from: import("./index.js").HudPlacement}|null} */
        let drag = null;

        box.onpointerdown = (event) => {
            event.preventDefault();
            select(item);
            box.setPointerCapture(event.pointerId);
            box.classList.add("hudDragging");
            // measured once here, never inside the move handler
            drag = { x: event.clientX, y: event.clientY, rect: box.getBoundingClientRect(), from: { ...placeOf(item.def.key) } };
        };
        box.onpointermove = (event) => {
            if (!drag || !box.hasPointerCapture(event.pointerId)) return;
            const [dx, dy] = snap(item, drag.rect, event.clientX - drag.x, event.clientY - drag.y);
            box.style.left = `${Math.round(drag.rect.left + dx)}px`;
            box.style.top = `${Math.round(drag.rect.top + dy)}px`;
            moveTo(item, dx, dy, drag.from);
        };
        const endDrag = () => {
            if (!drag) return;
            drag = null;
            box.classList.remove("hudDragging");
            guides[0].style.display = "none";
            guides[1].style.display = "none";
            syncBoxes();
            refreshRows();
        };
        box.onpointerup = endDrag;
        box.onpointercancel = endDrag;
        box.onwheel = (event) => {
            event.preventDefault();
            select(item);
            const place = placeOf(item.def.key);
            place.s = round(clamp((place.s ?? 1) + (event.deltaY < 0 ? 0.05 : -0.05), 0.3, 3));
            applyLive();
            syncBoxes();
            refreshRows();
        };
    }

    // ── the panel ──

    const host = document.createElement("div");
    // the middle of the screen is the one place no HUD widget sits, and the panel can be dragged anyway
    host.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%, -50%)";
    overlay.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = panelHtml;

    /**
     * @param {string} id
     * @return {HTMLElement}
     */
    const element = (id) => /** @type {HTMLElement} */ (shadow.querySelector(`#${id}`));

    /**
     * Turns a widget on or off through the setting that owns it: Krunker's own for its widgets, ours for ours.
     *
     * @param {Item} item
     * @param {boolean} value
     */
    const setVisible = (item, value) => {
        const { def } = item;
        if (def.setting){
            window.setSetting(def.setting, value);
        }
        else if (def.clientSetting){
            const id = def.clientSetting;
            kute.settings.data[id] = value;
            window.chrome.webview.postMessage(`set-config, ${id}, ${value}`);
            const toggleName = /** @type {const} */ (`toggle${id.charAt(0).toUpperCase()}${id.slice(1)}`);
            if (typeof kute.settings[toggleName] === "function") kute.settings[toggleName](value);
            // the client settings tab may be open behind the editor
            const input = /** @type {HTMLInputElement|null} */ (document.querySelector(`#${id}`));
            if (input) input.checked = value;
        }
        refreshGhosts();
        requestAnimationFrame(() => {
            syncBoxes();
            refreshRows();
        });
    };

    const list = element("hpList");
    let group = "";
    for (const item of items){
        const { def } = item;
        if (def.group !== group){
            ({ group } = def);
            const header = document.createElement("div");
            header.className = "hpGroup";
            header.textContent = group.toUpperCase();
            list.append(header);
        }

        const row = document.createElement("label");
        row.className = "hpRow";
        const name = document.createElement("span");
        name.className = "hpName";
        name.textContent = def.name;
        if (def.note){
            const note = document.createElement("span");
            note.className = "hpNote";
            note.textContent = ` ${def.note}`;
            name.append(note);
        }
        const moved = document.createElement("span");
        moved.className = "hpMoved";
        const reset = document.createElement("span");
        reset.className = "hpReset";
        reset.textContent = "reset";
        reset.title = "Put it back where Krunker had it";
        reset.onclick = (event) => {
            event.preventDefault();
            delete layout[def.key];
            applyLive();
            syncBoxes();
            refreshRows();
        };
        row.append(name, moved, reset);

        if (def.setting || def.clientSetting){
            const check = document.createElement("input");
            check.type = "checkbox";
            check.checked = shown(item);
            check.onchange = () => setVisible(item, check.checked);
            row.append(check);
            panelChecks.set(def.key, check);
        }
        row.onpointerenter = () => highlight(item, true);
        row.onpointerleave = () => highlight(item, false);
        list.append(row);
        panelRows.set(def.key, row);
    }

    const panel = element("hpPanel");
    const head = element("hpHead");
    /** @type {{x: number, y: number}|null} */
    let panelDrag = null;
    head.onpointerdown = (event) => {
        const rect = host.getBoundingClientRect();
        host.style.cssText = `position:fixed;left:${Math.round(rect.left)}px;top:${Math.round(rect.top)}px`;
        head.setPointerCapture(event.pointerId);
        panelDrag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        panel.classList.add("hpBusy");
    };
    head.onpointermove = (event) => {
        if (!panelDrag) return;
        host.style.left = `${Math.round(event.clientX - panelDrag.x)}px`;
        host.style.top = `${Math.round(event.clientY - panelDrag.y)}px`;
    };
    head.onpointerup = () => {
        panelDrag = null;
        panel.classList.remove("hpBusy");
    };

    const master = /** @type {HTMLInputElement} */ (element("hpShowUI"));
    master.checked = gameSettingOn(SHOW_UI_SETTING);
    master.onchange = () => {
        window.setSetting(SHOW_UI_SETTING, master.checked);
        requestAnimationFrame(syncBoxes);
    };

    const controller = new AbortController();
    const close = () => {
        controller.abort();
        overlay.remove();
        editorStyle.remove();
        ghostStyle.remove();
        document.documentElement.classList.remove("kuteHudEdit");
        hud.save(layout);
        hud.closed();
    };

    element("hpDone").onclick = close;
    element("hpReset").onclick = () => {
        for (const key of Object.keys(layout)) delete layout[key];
        applyLive();
        syncBoxes();
        refreshRows();
    };

    document.addEventListener(
        "keydown",
        (event) => {
            if (event.key === "Escape" || event.key === "F7"){
                event.preventDefault();
                event.stopPropagation();
                close();
                return;
            }
            if (!selected || !event.key.startsWith("Arrow")) return;
            event.preventDefault();
            event.stopPropagation();
            const step = event.shiftKey ? 10 : 1;
            const dx = (event.key === "ArrowRight" ? step : 0) - (event.key === "ArrowLeft" ? step : 0);
            const dy = (event.key === "ArrowDown" ? step : 0) - (event.key === "ArrowUp" ? step : 0);
            moveTo(selected, dx, dy, { ...placeOf(selected.def.key) });
            syncBoxes();
            refreshRows();
        },
        { signal: controller.signal, capture: true },
    );

    window.addEventListener("resize", () => syncBoxes(), { signal: controller.signal });

    refreshGhosts();
    requestAnimationFrame(() => {
        syncBoxes();
        refreshRows();
    });
}
