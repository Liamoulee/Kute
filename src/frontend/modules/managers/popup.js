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
 * Whether the exe understands the manager commands (scripts-*, swapper-*, drop-zone).
 *
 * @return {boolean}
 */
export const hostSupportsManagers = () => kute.hostFeatures?.includes("script-manager") ?? false;

/**
 * The frame both managers live in: an overlay with a shadow root, keys kept away from Krunker's hotkeys, external
 * file drops allowed while it is open (the host only accepts them then), and the host's replies routed to
 * `onMessage` until it closes.
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
    window.chrome.webview.postMessage("drop-zone, true");

    const close = () => {
        if (signal.aborted || (canClose && !canClose())) return;
        controller.abort();
        window.chrome.webview.removeEventListener("message", listener);
        window.chrome.webview.postMessage("drop-zone, false");
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
    // a file dropped next to a drop zone must not make Chromium open it in place of the game
    for (const type of ["dragover", "drop"]){
        overlay.addEventListener(type, (event) => {
            event.preventDefault();
            if (event instanceof DragEvent && event.dataTransfer && type === "dragover") event.dataTransfer.dropEffect = "none";
        });
    }

    shadow.querySelector("[data-close]")?.addEventListener("click", close);

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

    document.body.append(overlay);
    return { shadow, close, signal, showError };
}

/**
 * Makes an element a drop target for files from outside. The host already knows the paths (it took them from the
 * drag), the page only tells it where they go.
 *
 * @param {HTMLElement} element
 * @param {() => void} onDrop
 * @param {AbortSignal} signal
 */
export function makeDropTarget(element, onDrop, signal){
    element.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        element.classList.add("dropHover");
    }, { signal });
    element.addEventListener("dragleave", (event) => {
        if (!element.contains(/** @type {Node|null} */ (event.relatedTarget))) element.classList.remove("dropHover");
    }, { signal });
    element.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        element.classList.remove("dropHover");
        if (event.dataTransfer?.files.length) onDrop();
    }, { signal });
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
