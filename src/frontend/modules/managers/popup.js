import { kute } from "../../client.js";
import sharedCss from "../../components/managers/manager.css";

/**
 * @typedef {object} ManagerPopup
 * @property {ShadowRoot} shadow
 * @property {() => void} close
 * @property {AbortSignal} signal Aborted on close, for listeners that belong to the popup
 * @property {(message: string) => void} showError
 */

/**
 * Whether the exe understands the manager commands (scripts-*, swapper-*).
 *
 * @return {boolean}
 */
export const hostSupportsManagers = () => kute.hostFeatures?.includes("script-manager") ?? false;

/**
 * @typedef {object} DroppedFile
 * @property {string} path Relative to what was dropped: "a.js", or "textures/a.png" when a folder was dropped
 * @property {File} file
 */

/** @type {WeakMap<HTMLElement, (files: DroppedFile[]) => void>} */
const dropTargets = new WeakMap();

// a pack with more files than this is a mistake (a whole drive), not a swapper pack
const MAX_DROPPED_FILES = 5000;

/**
 * Marks an element as a place files can be dropped on. The popup finds the innermost one under the cursor, so nested
 * targets (a folder row inside a column) each get the drop meant for them, and only that one lights up.
 *
 * @param {HTMLElement} element
 * @param {(files: DroppedFile[]) => void} onDrop
 */
export function makeDropTarget(element, onDrop){
    dropTargets.set(element, onDrop);
}

/**
 * Everything that was dropped, folders walked. The entries have to be taken while the drop event runs, the
 * DataTransfer is empty afterwards.
 *
 * @param {DataTransfer} dataTransfer
 * @return {Promise<DroppedFile[]>}
 */
function collectDropped(dataTransfer){
    const entries = [...dataTransfer.items]
        .filter((item) => item.kind === "file")
        .map((item) => item.webkitGetAsEntry())
        .filter((entry) => entry !== null);
    if (!entries.length) return Promise.resolve([...dataTransfer.files].map((file) => ({ path: file.name, file })));

    /** @type {DroppedFile[]} */
    const found = [];
    /**
     * @param {FileSystemEntry} entry
     * @return {Promise<void>}
     */
    const walk = async(entry) => {
        if (found.length >= MAX_DROPPED_FILES) return;
        if (entry.isFile){
            const file = await new Promise((resolve, reject) => /** @type {FileSystemFileEntry} */ (entry).file(resolve, reject));
            found.push({ path: entry.fullPath.replace(/^\/+/, ""), file });
            return;
        }
        const reader = /** @type {FileSystemDirectoryEntry} */ (entry).createReader();
        // readEntries hands out a directory in batches, an empty one means done
        for (;;){
            /** @type {FileSystemEntry[]} */
            const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
            if (!batch.length) break;
            for (const child of batch) await walk(child);
        }
    };
    return Promise.all(entries.map(walk)).then(() => found);
}

/**
 * @param {File} file
 * @return {Promise<string>} The content as base64
 */
export const readBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
});

/**
 * The frame both managers live in: an overlay with a shadow root, keys kept away from Krunker's hotkeys, dropped
 * files handed to the drop target under the cursor, and the host's replies routed to `onMessage` until it closes.
 *
 * @param {string} html Markup of the popup, the shared styles are added in front
 * @param {object} options
 * @param {(data: any) => void} options.onMessage Every host message while the popup is open
 * @param {() => boolean} [options.canClose] Asked before closing, false keeps it open
 * @param {() => boolean} [options.onEscape] Gets Escape first, true when it handled it (a step back inside the popup)
 * @return {ManagerPopup}
 */
export function openManagerPopup(html, { onMessage, canClose, onEscape }){
    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
    const host = document.createElement("div");
    overlay.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${sharedCss}</style>${html}`;

    const controller = new AbortController();
    const { signal } = controller;

    /**
     * @param {MessageEvent} event
     */
    const listener = (event) => {
        if (event.data && typeof event.data === "object") onMessage(event.data);
    };
    window.chrome.webview.addEventListener("message", listener);

    const close = () => {
        if (signal.aborted || (canClose && !canClose())) return;
        controller.abort();
        window.chrome.webview.removeEventListener("message", listener);
        overlay.remove();
    };

    // krunker binds its hotkeys on the document, typing in the popup must not trigger them
    for (const type of ["keydown", "keyup", "keypress"]){
        shadow.addEventListener(type, (event) => event.stopPropagation());
    }
    document.addEventListener(
        "keydown",
        (event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            // an open question closes first, then whatever step the popup is in, then the popup
            const cancel = /** @type {HTMLElement|null} */ (shadow.querySelector(".askBackdrop [data-cancel]"));
            if (cancel) cancel.click();
            else if (!onEscape?.()) close();
        },
        { signal, capture: true },
    );
    overlay.addEventListener("mousedown", (event) => {
        if (event.target === overlay) close();
    });

    const errorBox = /** @type {HTMLElement|null} */ (shadow.querySelector("[data-error]"));
    /** @type {number} */
    let errorTimer = 0;
    /**
     * @param {string} message
     */
    const showError = (message) => {
        if (!errorBox) return;
        errorBox.textContent = message;
        errorBox.hidden = false;
        clearTimeout(errorTimer);
        errorTimer = setTimeout(() => {
            errorBox.hidden = true;
        }, 8000);
    };

    /** @type {HTMLElement|null} */
    let hovered = null;
    /**
     * @param {HTMLElement|null} target
     */
    const setHovered = (target) => {
        if (hovered === target) return;
        hovered?.classList.remove("dropHover");
        hovered = target;
        target?.classList.add("dropHover");
    };
    /**
     * @param {DragEvent} event
     * @return {HTMLElement|null} The innermost drop target under the cursor
     */
    const targetOf = (event) => {
        for (const node of event.composedPath()){
            if (node === overlay) break;
            if (node instanceof HTMLElement && dropTargets.has(node)) return node;
        }
        return null;
    };
    // every drag event is handled here: a file dropped next to a target must not make Chromium open it in place of
    // the game, and a target must not stay lit because the drop went to a target inside it
    overlay.addEventListener("dragover", (event) => {
        event.preventDefault();
        const target = targetOf(event);
        setHovered(target);
        if (event.dataTransfer) event.dataTransfer.dropEffect = target ? "copy" : "none";
    });
    overlay.addEventListener("dragleave", (event) => {
        // null: the drag left the window
        if (!event.relatedTarget) setHovered(null);
    });
    overlay.addEventListener("drop", (event) => {
        event.preventDefault();
        const target = targetOf(event);
        setHovered(null);
        const onDrop = target && dropTargets.get(target);
        if (!onDrop || !event.dataTransfer) return;
        collectDropped(event.dataTransfer)
            .then((files) => {
                if (files.length) onDrop(files);
            })
            .catch((error) => showError(`Could not read the dropped files: ${error?.message ?? error}`));
    });

    shadow.querySelector("[data-close]")?.addEventListener("click", close);

    document.body.append(overlay);
    return { shadow, close, signal, showError };
}

/**
 * A small question inside the popup (the page has no prompt(), and Krunker's own would steal the keys).
 *
 * @param {ShadowRoot} shadow
 * @param {string} title
 * @param {string} initial
 * @param {string} [hint]
 * @return {Promise<string|null>} null when cancelled
 */
export function askText(shadow, title, initial, hint = ""){
    const dialog = document.createElement("div");
    dialog.className = "askBackdrop";
    dialog.innerHTML = `<div class="askBox"><div class="askTitle"></div><input class="askInput" spellcheck="false">
        <div class="askHint"></div><div class="askActions"><div class="btn" data-cancel>Cancel</div><div class="btn primary" data-ok>OK</div></div></div>`;
    /** @type {HTMLElement} */ (dialog.querySelector(".askTitle")).textContent = title;
    /** @type {HTMLElement} */ (dialog.querySelector(".askHint")).textContent = hint;
    const input = /** @type {HTMLInputElement} */ (dialog.querySelector(".askInput"));
    input.value = initial;
    const popup = shadow.querySelector(".managerPopup") ?? shadow;
    popup.append(dialog);
    input.focus();
    // select the name without its extension, like Explorer does
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(initial.lastIndexOf("/") + 1, dot > 0 ? dot : initial.length);

    return new Promise((resolve) => {
        /**
         * @param {string|null} value
         */
        const finish = (value) => {
            dialog.remove();
            resolve(value);
        };
        /** @type {HTMLElement} */ (dialog.querySelector("[data-ok]")).onclick = () => finish(input.value.trim() || null);
        /** @type {HTMLElement} */ (dialog.querySelector("[data-cancel]")).onclick = () => finish(null);
        input.onkeydown = (event) => {
            if (event.key === "Enter") finish(input.value.trim() || null);
        };
    });
}

/**
 * A yes/no question inside the popup.
 *
 * @param {ShadowRoot} shadow
 * @param {string} title
 * @param {string} text
 * @param {string} confirmLabel
 * @return {Promise<boolean>}
 */
export function askConfirm(shadow, title, text, confirmLabel){
    const dialog = document.createElement("div");
    dialog.className = "askBackdrop";
    dialog.innerHTML = `<div class="askBox"><div class="askTitle"></div><div class="askHint"></div>
        <div class="askActions"><div class="btn" data-cancel>Cancel</div><div class="btn primary" data-ok></div></div></div>`;
    /** @type {HTMLElement} */ (dialog.querySelector(".askTitle")).textContent = title;
    /** @type {HTMLElement} */ (dialog.querySelector(".askHint")).textContent = text;
    const ok = /** @type {HTMLElement} */ (dialog.querySelector("[data-ok]"));
    ok.textContent = confirmLabel;
    (shadow.querySelector(".managerPopup") ?? shadow).append(dialog);

    return new Promise((resolve) => {
        /**
         * @param {boolean} value
         */
        const finish = (value) => {
            dialog.remove();
            resolve(value);
        };
        ok.onclick = () => finish(true);
        /** @type {HTMLElement} */ (dialog.querySelector("[data-cancel]")).onclick = () => finish(false);
    });
}

/**
 * @param {number} bytes
 * @return {string}
 */
export const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
