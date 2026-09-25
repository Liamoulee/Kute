import { kute } from "../../client.js";
import html from "../../components/managers/customCss.html";
import customCss, { hostSupportsCustomCss } from "../customCss.js";
import { openManagerPopup, askConfirm } from "./popup.js";
import { createEditorView } from "./editor.js";

// live preview replaces the whole sheet, keep that off the keystroke on big files
const PREVIEW_DELAY = 120;

class CustomCssEditor {
    constructor(){
        /** @type {import("./popup.js").ManagerPopup|null} */
        this.popup = null;
        /** @type {import("./editor.js").CodeEditor|null} */
        this.editor = null;
        /** @type {string|null} content of a save on its way */
        this.saving = null;
        this.closeAfterSave = false;
        this.forceClose = false;
        this.live = true;
        /** @type {number} */
        this.previewTimer = 0;
    }

    open(){
        if (this.popup) return;
        if (!hostSupportsCustomCss()){
            kute.showNotification("Custom CSS needs a newer Kute. Update Kute to use it.", false, 6);
            return;
        }
        this.popup = openManagerPopup(html, {
            onMessage: (data) => this.receive(data),
            canClose: () => this.canClose(),
        });
        const { shadow, signal } = this.popup;
        signal.addEventListener("abort", () => {
            clearTimeout(this.previewTimer);
            // closing without saving drops the preview
            customCss.revert();
            this.popup = null;
            this.editor = null;
            this.saving = null;
            this.forceClose = false;
        });
        /** @type {HTMLElement} */ (shadow.querySelector("#ccFolder")).onclick = () => window.chrome.webview.postMessage("css-reveal");
        /** @type {HTMLElement} */ (shadow.querySelector("#ccOff")).hidden = kute.settings.data.customCss !== false;

        const live = /** @type {HTMLInputElement} */ (shadow.querySelector("#ccLive"));
        live.checked = this.live;
        live.onchange = () => {
            this.live = live.checked;
            if (this.live && this.editor) customCss.apply(this.editor.getValue());
            else customCss.revert();
        };

        const overlay = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (shadow.host).parentElement);
        const peek = /** @type {HTMLElement} */ (shadow.querySelector("#ccPeek"));
        peek.onpointerdown = (event) => {
            event.preventDefault();
            overlay.style.opacity = "0";
            window.addEventListener("pointerup", () => {
                overlay.style.opacity = "";
            }, { once: true, signal });
        };

        this.body().textContent = "Loading...";
        window.chrome.webview.postMessage("css-read");
    }

    /**
     * @return {HTMLElement}
     */
    body(){
        return /** @type {HTMLElement} */ (this.popup?.shadow.querySelector("#ccBody"));
    }

    /**
     * @param {any} data
     */
    receive(data){
        if (typeof data.customCss?.content === "string" && !this.editor) this.showEditor(data.customCss.content);
        if (data.customCssSaved && this.saving !== null){
            const content = this.saving;
            this.saving = null;
            if (data.customCssSaved.error){
                this.popup?.showError(`Could not save: ${data.customCssSaved.error}`);
                return;
            }
            customCss.markSaved(content);
            this.editor?.markSaved();
            if (this.closeAfterSave) this.popup?.close();
        }
    }

    /**
     * @param {string} content
     */
    showEditor(content){
        const body = this.body();
        if (!body) return;
        const { editor } = createEditorView(body, {
            title: "custom.css",
            content,
            language: "css",
            onSave: (closeAfter) => this.save(closeAfter),
            onClose: () => this.popup?.close(),
            onChange: (value) => {
                if (!this.live) return;
                clearTimeout(this.previewTimer);
                this.previewTimer = setTimeout(() => customCss.apply(value), PREVIEW_DELAY);
            },
        });
        this.editor = editor;
    }

    /**
     * @param {boolean} closeAfter
     */
    save(closeAfter){
        if (!this.editor || this.saving !== null) return;
        this.closeAfterSave = closeAfter;
        this.saving = this.editor.getValue();
        window.chrome.webview.postMessage(`css-write ${JSON.stringify({ content: this.saving })}`);
    }

    /**
     * @return {boolean}
     */
    canClose(){
        if (this.forceClose || !this.editor?.isDirty() || !this.popup) return true;
        askConfirm(this.popup.shadow, "Unsaved changes", "Close and throw the changes away?", "Discard").then((discard) => {
            if (!discard) return;
            this.forceClose = true;
            this.popup?.close();
        });
        return false;
    }
}

const editor = new CustomCssEditor();

export const open = () => editor.open();
