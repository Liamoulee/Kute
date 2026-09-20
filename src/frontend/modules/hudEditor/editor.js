import styles from "../../components/hudEditor.css";
import panelHtml from "../../components/hudEditorPanel.html";
import { kute } from "../../client.js";
import { HUD_ELEMENTS, gameSettingOn } from "./elements.js";

/** How close two edges have to be for a drag to snap, in screen pixels. */
const SNAP_PX = 6;
/** The box an empty widget (an idle kill feed, an unused powerup slot) gets, in screen pixels. */
const EMPTY_BOX = 24;

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
 * @property {HTMLElement} box
 * @property {number} x Where the widget sits in the match, without our offsets
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {boolean} empty The widget had nothing in it when the snapshot was taken
 * @property {DOMRect|null} drawn Where its box is right now
 */

/**
 * The editor: labelled boxes over a snapshot of the real in-match HUD.
 *
 * It never measures the page while it is open, because by then the pointer is unlocked and Krunker has laid the
 * HUD out for the menu. Everything drawn comes from the snapshot plus the offsets being edited, so what the boxes
 * show is what the match will look like.
 *
 * @param {import("./index.js").HudEditor} hud
 * @param {import("./index.js").HudGeometry} geometry
 * @return {Promise<void>}
 */
export async function openEditor(hud, geometry){
    if (document.pointerLockElement) document.exitPointerLock();
    // out of the key press that opened us: our own Escape and F7 handler would otherwise see that same event
    await new Promise((resolve) => setTimeout(resolve, 0));

    const { layout } = hud;

    const editorStyle = document.createElement("style");
    editorStyle.id = "kute_hudEditorCSS";
    editorStyle.textContent = styles;
    document.head.append(editorStyle);
    document.documentElement.classList.add("kuteHudEdit");

    const overlay = document.createElement("div");
    overlay.id = "kuteHudEditor";
    document.body.append(overlay);

    /**
     * What a widget's box should be.
     *
     * A widget that was on screen when the layout was measured gives its own rect. One that this mode or a
     * setting hides was measured through a probe, and a probe reports the holder it sits in (the round message
     * is as wide as the screen, the team score strip is 600 px of nothing), so all it is trusted for is where
     * the widget is anchored. Those get a small handle there instead of a made up size.
     *
     * @param {import("./elements.js").HudElement} def
     * @param {[number, number, number, number, number]} rect
     * @return {{x: number, y: number, w: number, h: number, empty: boolean}}
     */
    const boxFor = (def, rect) => {
        const [rx, ry, rw, rh, visible] = rect;
        const empty = !visible || rw <= 0 || rh <= 0;
        // a holder reported instead of the widget: it covers half the screen or more
        const oversizeX = rw > window.innerWidth * 0.5;
        const oversizeY = rh > window.innerHeight * 0.5;

        let w = empty ? EMPTY_BOX : rw;
        let h = empty ? EMPTY_BOX : rh;
        let x = rx;
        let y = ry;
        if (!empty && oversizeX){
            w = def.size?.[0] ?? EMPTY_BOX;
            x = rx + rw / 2 - w / 2;
        }
        if (!empty && oversizeY){
            h = def.size?.[1] ?? EMPTY_BOX;
            y = ry + rh / 2 - h / 2;
        }
        // an anchor on the right or bottom edge grows its handle back towards the middle
        if (empty && rx > window.innerWidth / 2) x = rx - w;
        if (empty && ry > window.innerHeight / 2) y = ry - h;

        w = Math.min(w, window.innerWidth);
        h = Math.min(h, window.innerHeight);
        return { x: clamp(x, 0, window.innerWidth - w), y: clamp(y, 0, window.innerHeight - h), w, h, empty };
    };

    /**
     * Handles of widgets that were not on screen sit on their anchors, and anchors of a row (the powerup slots)
     * are only a few pixels apart. This pushes the handles off each other so every one of them can be grabbed.
     *
     * @param {Item[]} all
     */
    const spreadHandles = (all) => {
        // the widgets that were really on screen keep their place, the handles move around them
        const placed = all.filter((item) => !item.empty);
        for (const item of all){
            if (!item.empty) continue;
            for (let tries = 0; tries < 12; tries++){
                const clash = placed.find(
                    (other) => item.x < other.x + other.w && item.x + item.w > other.x && item.y < other.y + other.h && item.y + item.h > other.y,
                );
                if (!clash) break;
                const down = item.y + item.h + 2;
                if (down + item.h <= window.innerHeight) item.y = Math.min(clash.y + clash.h + 2, window.innerHeight - item.h);
                else item.x = clamp(clash.x + clash.w + 2, 0, window.innerWidth - item.w);
            }
            placed.push(item);
        }
    };

    /** @type {Item[]} */
    const items = [];
    for (const def of HUD_ELEMENTS){
        const rect = geometry.rects[def.key];
        if (!rect) continue;

        const box = document.createElement("div");
        box.className = "hudBox";
        const label = document.createElement("div");
        label.className = "hudLabel";
        label.textContent = def.name;
        box.append(label);
        overlay.append(box);

        items.push({ def, box, ...boxFor(def, rect), drawn: null });
    }
    spreadHandles(items);

    // labels sit above their box. Small boxes standing next to each other (the powerup row) would stack their
    // labels on each other, so every other one goes below, as long as there is screen left down there
    let flip = false;
    for (const item of items){
        if (item.w > 60){
            flip = false;
        }
        const below = flip && item.y + item.h + 20 < window.innerHeight;
        item.box.classList.toggle("hudLabelBelow", below || item.y < 18);
        flip = item.w > 60 ? false : !flip;
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
     * @param {import("./elements.js").HudElement} def
     * @return {boolean}
     */
    const shown = (def) => {
        if (def.setting) return gameSettingOn(def.setting);
        if (def.clientSetting) return kute.settings.data[def.clientSetting] !== false;
        return true;
    };

    /**
     * @param {string} key
     * @return {import("./index.js").HudPlacement}
     */
    const placeOf = (key) => (layout[key] ??= {});

    /**
     * An offset in vw/vh, in screen pixels. Krunker's UI scaling scales what an offset does, which is why the
     * snapshot carries the factor it was measured with.
     *
     * @param {number} vw
     * @param {number} vh
     * @return {[number, number]}
     */
    const offsetPx = (vw, vh) => [
        (vw / 100) * window.innerWidth * geometry.factor,
        (vh / 100) * window.innerHeight * geometry.factor,
    ];

    /**
     * Draws one box from the snapshot and the offsets being edited. Scale grows the widget around its middle,
     * the way the CSS does it in the match.
     *
     * @param {Item} item
     */
    const draw = (item) => {
        const place = layout[item.def.key] ?? {};
        const [dx, dy] = offsetPx(place.x ?? 0, place.y ?? 0);
        const scale = place.s ?? 1;
        const width = item.w * scale;
        const height = item.h * scale;
        const left = item.x + item.w / 2 + dx - width / 2;
        const top = item.y + item.h / 2 + dy - height / 2;

        item.box.style.left = `${Math.round(left)}px`;
        item.box.style.top = `${Math.round(top)}px`;
        item.box.style.width = `${Math.round(width)}px`;
        item.box.style.height = `${Math.round(height)}px`;
        item.box.classList.toggle("hudOff", !shown(item.def));
        item.box.classList.toggle("hudEmpty", item.empty);
        item.drawn = new DOMRect(left, top, width, height);
    };

    const drawAll = () => {
        for (const item of items) draw(item);
    };

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
            if (check) check.checked = shown(item.def);
        }
    };

    /** @type {Item|null} */
    let selected = null;

    /**
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
        const factor = geometry.factor || 1;
        place.x = round((from.x ?? 0) + (screenX / (window.innerWidth * factor)) * 100);
        place.y = round((from.y ?? 0) + (screenY / (window.innerHeight * factor)) * 100);
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
            if (other === item || !other.drawn) continue;
            verticals.push(other.drawn.left, other.drawn.left + other.drawn.width / 2, other.drawn.right);
            horizontals.push(other.drawn.top, other.drawn.top + other.drawn.height / 2, other.drawn.bottom);
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
            drag = {
                x: event.clientX,
                y: event.clientY,
                rect: item.drawn ?? box.getBoundingClientRect(),
                from: { ...placeOf(item.def.key) },
            };
        };
        box.onpointermove = (event) => {
            if (!drag || !box.hasPointerCapture(event.pointerId)) return;
            const [dx, dy] = snap(item, drag.rect, event.clientX - drag.x, event.clientY - drag.y);
            moveTo(item, dx, dy, drag.from);
            draw(item);
        };
        const endDrag = () => {
            if (!drag) return;
            drag = null;
            box.classList.remove("hudDragging");
            guides[0].style.display = "none";
            guides[1].style.display = "none";
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
            draw(item);
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
     * @param {import("./elements.js").HudElement} def
     * @param {boolean} value
     */
    const setVisible = (def, value) => {
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
        drawAll();
        refreshRows();
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
            draw(item);
            refreshRows();
        };
        row.append(name, moved, reset);

        if (def.setting || def.clientSetting){
            const check = document.createElement("input");
            check.type = "checkbox";
            check.checked = shown(def);
            check.onchange = () => setVisible(def, check.checked);
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

    const controller = new AbortController();
    const close = () => {
        controller.abort();
        overlay.remove();
        editorStyle.remove();
        document.documentElement.classList.remove("kuteHudEdit");
        hud.save(layout);
        hud.closed();
    };

    element("hpDone").onclick = close;
    // every box comes from a snapshot taken at one window size, so a resize makes all of them wrong
    window.addEventListener(
        "resize",
        () => {
            close();
            kute.showNotification?.("The window changed size, open the HUD editor again", false, 5);
        },
        { signal: controller.signal },
    );
    element("hpReset").onclick = () => {
        for (const key of Object.keys(layout)) delete layout[key];
        applyLive();
        drawAll();
        refreshRows();
    };

    document.addEventListener(
        "keydown",
        (event) => {
            if (event.key === "Escape"){
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
            draw(selected);
            refreshRows();
        },
        { signal: controller.signal, capture: true },
    );

    drawAll();
    refreshRows();
}
