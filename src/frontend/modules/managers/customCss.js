import { kute } from "../../client.js";
import html from "../../components/managers/customCss.html";
import customCss, { hostSupportsCustomCss } from "../customCss.js";
import { openManagerPopup, askConfirm, askText, makeDropTarget, formatSize } from "./popup.js";
import { createEditorView } from "./editor.js";

// live preview replaces the whole sheet, keep that off the keystroke on big files
const PREVIEW_DELAY = 120;
const MAX_SIZE = 4 * 1024 * 1024;
// what an exe before the css manager calls its one file
const LEGACY_FILE = "custom.css";

/**
 * @return {boolean}
 */
const hostSupportsManager = () => kute.hostFeatures?.includes("css-manager") ?? false;

/**
 * @param {string} name
 * @return {string}
 */
const cssName = (name) => (/\.css$/i.test(name) ? name : `${name}.css`);

/**
 * @param {string} command
 * @param {object} [payload]
 */
const post = (command, payload) => window.chrome.webview.postMessage(payload ? `css-${command} ${JSON.stringify(payload)}` : `css-${command}`);

/** @typedef {{name: string, size: number}} CssFile */

class CssManager {
    constructor(){
        /** @type {import("./popup.js").ManagerPopup|null} */
        this.popup = null;
        /** @type {import("./editor.js").CodeEditor|null} */
        this.editor = null;
        /** @type {string|null} file in the editor */
        this.editing = null;
        /** @type {string|null} file asked for, the editor switches once it arrives */
        this.loading = null;
        /** @type {CssFile[]} */
        this.files = [];
        /** @type {string|null} */
        this.active = null;
        this.listed = false;
        /** @type {string|null} content of a save on its way */
        this.saving = null;
        /** @type {string|null} */
        this.savingName = null;
        /** @type {{from: string, to: string}|null} */
        this.renaming = null;
        /** @type {string|null} new or pasted file to open once the host wrote it */
        this.openAfterImport = null;
        // one activation at a time, several imports into an empty list would each ask for one
        this.activating = false;
        this.closeAfterSave = false;
        this.forceClose = false;
        this.legacy = false;
        this.live = true;
        /** @type {number} */
        this.previewTimer = 0;
    }

    open(){
        if (this.popup) return;
        if (!hostSupportsCustomCss()){
            kute.showNotification("The CSS Manager needs a newer Kute. Update Kute to use it.", false, 6);
            return;
        }
        this.legacy = !hostSupportsManager();
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
            this.editing = null;
            this.loading = null;
            this.listed = false;
            this.saving = null;
            this.renaming = null;
            this.openAfterImport = null;
            this.activating = false;
            this.forceClose = false;
        });
        this.$("#ccFolder").onclick = () => post("reveal", { name: this.editing ?? "" });
        this.$("#ccOff").hidden = kute.settings.data.customCss !== false;

        const live = /** @type {HTMLInputElement} */ (this.$("#ccLive"));
        live.checked = this.live;
        live.onchange = () => {
            this.live = live.checked;
            this.preview();
        };

        const overlay = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (shadow.host).parentElement);
        this.$("#ccPeek").onpointerdown = (event) => {
            event.preventDefault();
            overlay.style.opacity = "0";
            window.addEventListener("pointerup", () => {
                overlay.style.opacity = "";
            }, { once: true, signal });
        };

        if (this.legacy){
            this.$(".managerPopup").classList.add("legacy");
            this.$("#ccHint").textContent = "Loaded after all of Krunker's styles, so a rule with the same selector wins. " +
                "Saved as Documents\\kute\\custom.css. Update Kute to keep several CSS files and switch between them.";
            this.$("#ccEditor").textContent = "Loading...";
            post("read");
            return;
        }

        this.$("#ccNew").onclick = () => this.create();
        this.$("#ccPaste").onclick = () => this.paste();
        const input = /** @type {HTMLInputElement} */ (this.$("#ccImportInput"));
        this.$("#ccImport").onclick = () => input.click();
        input.onchange = () => {
            this.importFiles([...input.files ?? []]);
            input.value = "";
        };
        makeDropTarget(this.$("#ccFiles"), (dropped) => this.importFiles(dropped.map((entry) => entry.file)));
        this.$("#ccEditor").textContent = "Loading...";
        post("list");
    }

    /**
     * @param {string} selector
     * @return {HTMLElement}
     */
    $(selector){
        return /** @type {HTMLElement} */ (this.popup?.shadow.querySelector(selector));
    }

    /**
     * @param {any} data
     */
    receive(data){
        if (typeof data.managerError === "string") this.popup?.showError(data.managerError);
        if (this.legacy){
            if (typeof data.customCss?.content === "string" && !this.editor){
                this.active = LEGACY_FILE;
                this.showEditor(LEGACY_FILE, data.customCss.content);
            }
            if (data.customCssSaved && this.saving !== null) this.saved(data.customCssSaved.error, LEGACY_FILE);
            return;
        }
        if (data.cssFiles) this.updateList(data.cssFiles);
        if (data.cssFile && data.cssFile.name === this.loading){
            this.loading = null;
            if (typeof data.cssFile.content === "string") this.showEditor(data.cssFile.name, data.cssFile.content);
            else this.popup?.showError(`Could not read ${data.cssFile.name}`);
        }
        if (data.cssSaved && this.saving !== null && data.cssSaved.name === this.savingName) this.saved(data.cssSaved.error, data.cssSaved.name);
        if (data.cssImported) this.imported(data.cssImported);
        if (data.cssActivated){
            this.activating = false;
            if (data.cssActivated.error) this.popup?.showError(`Could not switch: ${data.cssActivated.error}`);
            else customCss.markSaved(String(data.cssActivated.content ?? ""));
            this.preview();
        }
    }

    /**
     * @param {{files?: CssFile[], active?: string|null}} list
     */
    updateList(list){
        this.files = Array.isArray(list.files) ? list.files : [];
        const wasActive = this.active;
        this.active = list.active ?? null;
        // the active file got deleted
        if (wasActive && !this.active && !this.activating){
            customCss.markSaved("");
            this.preview();
        }
        const names = new Set(this.files.map((file) => file.name));
        if (this.renaming && this.editing === this.renaming.from && names.has(this.renaming.to)){
            this.editing = this.renaming.to;
            const title = this.popup?.shadow.querySelector(".editorFile")?.firstChild;
            if (title) title.textContent = this.editing;
        }
        this.renaming = null;
        if (this.editing && !names.has(this.editing)) this.closeEditor();
        if (!this.listed){
            this.listed = true;
            const first = this.active ?? this.files[0]?.name;
            if (first) this.load(first);
            else this.closeEditor();
        }
        this.renderList();
    }

    renderList(){
        const list = this.$("#ccList");
        if (!list) return;
        list.textContent = "";
        if (!this.files.length){
            const empty = document.createElement("div");
            empty.className = "empty";
            empty.textContent = "No CSS files yet. Make one with New, paste one, or import .css files.";
            list.append(empty);
        }
        for (const file of this.files) list.append(this.row(file));
        list.append(this.row(null));
    }

    /**
     * @param {CssFile|null} file null is the "None" row
     * @return {HTMLElement}
     */
    row(file){
        const name = file?.name ?? "";
        const row = document.createElement("div");
        row.className = "cssRow";
        row.classList.toggle("none", !file);
        row.classList.toggle("active", (this.active ?? "") === name);
        row.classList.toggle("editing", Boolean(file) && this.editing === name);

        const radio = document.createElement("div");
        radio.className = "cssRadio";
        radio.title = file ? "Use this one" : "No CSS";
        radio.onclick = (event) => {
            event.stopPropagation();
            this.activate(name);
        };
        const label = document.createElement("div");
        label.className = "cssName";
        label.textContent = file ? name : "None";
        row.append(radio, label);
        if (!file){
            row.onclick = () => this.activate("");
            return row;
        }

        const size = document.createElement("div");
        size.className = "cssSize";
        size.textContent = formatSize(file.size);
        const actions = document.createElement("div");
        actions.className = "cssActions";
        for (const [icon, title, action, danger] of /** @type {const} */ ([
            ["edit", "Rename", () => this.rename(name), false],
            ["delete", "Delete", () => this.remove(name), true],
        ])){
            const button = document.createElement("div");
            button.className = danger ? "iconBtn danger" : "iconBtn";
            button.title = title;
            button.innerHTML = `<span class="mi">${icon}</span>`;
            button.onclick = (event) => {
                event.stopPropagation();
                action();
            };
            actions.append(button);
        }
        row.append(size, actions);
        row.onclick = () => this.load(name);
        return row;
    }

    /**
     * @param {string} name
     */
    async load(name){
        if (name === this.editing && this.editor) return;
        if (!await this.discardChanges()) return;
        this.loading = name;
        post("get", { name });
    }

    /**
     * @param {string} name
     * @param {string} content
     */
    showEditor(name, content){
        const box = this.$("#ccEditor");
        if (!box) return;
        const { editor } = createEditorView(box, {
            title: name,
            content,
            language: "css",
            onSave: (closeAfter) => this.save(closeAfter),
            onClose: () => this.popup?.close(),
            onChange: () => {
                clearTimeout(this.previewTimer);
                this.previewTimer = setTimeout(() => this.preview(), PREVIEW_DELAY);
            },
        });
        this.editor = editor;
        this.editing = name;
        this.renderList();
        this.preview();
    }

    closeEditor(){
        this.editor = null;
        this.editing = null;
        const box = this.$("#ccEditor");
        if (box) box.innerHTML = "<div class=\"empty\">Pick a file below to edit it.</div>";
        this.preview();
    }

    // the edited file shows once it is the active one or has changes, opening another file only to read it changes nothing
    preview(){
        const { editor } = this;
        if (this.live && editor && (this.editing === this.active || editor.isDirty())) customCss.apply(editor.getValue());
        else customCss.revert();
    }

    /**
     * @return {Promise<boolean>} true when there is nothing to keep or the player threw it away
     */
    async discardChanges(){
        if (!this.editor?.isDirty() || !this.popup) return true;
        return askConfirm(this.popup.shadow, "Unsaved changes", `Throw the changes to ${this.editing} away?`, "Discard");
    }

    /**
     * @param {boolean} closeAfter
     */
    save(closeAfter){
        if (!this.editor || !this.editing || this.saving !== null) return;
        this.closeAfterSave = closeAfter;
        this.saving = this.editor.getValue();
        this.savingName = this.editing;
        if (this.legacy) window.chrome.webview.postMessage(`css-write ${JSON.stringify({ content: this.saving })}`);
        else post("save", { name: this.editing, content: this.saving });
    }

    /**
     * @param {string|null|undefined} error
     * @param {string} name
     */
    saved(error, name){
        const content = this.saving ?? "";
        this.saving = null;
        if (error){
            this.popup?.showError(`Could not save: ${error}`);
            return;
        }
        if (name === this.active) customCss.markSaved(content);
        if (name === this.editing) this.editor?.markSaved(content);
        this.preview();
        if (this.closeAfterSave) this.popup?.close();
    }

    /**
     * @param {string} name
     */
    activate(name){
        if (name === (this.active ?? "") || this.activating) return;
        this.activating = true;
        post("activate", { name });
    }

    async create(){
        if (!this.popup) return;
        const name = await askText(this.popup.shadow, "New CSS file", "theme.css", "Ends in .css");
        if (!name) return;
        this.openAfterImport = cssName(name);
        post("import", { name: this.openAfterImport, content: "" });
    }

    async paste(){
        if (!this.popup) return;
        let text = "";
        try {
            text = await navigator.clipboard.readText();
        }
        catch {
            this.popup.showError("Could not read the clipboard.");
            return;
        }
        if (!text.trim()){
            this.popup.showError("The clipboard has no text in it. Copy the CSS first.");
            return;
        }
        const name = await askText(this.popup.shadow, "Name for the pasted CSS", "pasted.css", "Ends in .css");
        if (!name) return;
        this.openAfterImport = cssName(name);
        post("import", { name: this.openAfterImport, content: text });
    }

    /**
     * @param {File[]} files
     */
    async importFiles(files){
        /** @type {string[]} */
        const skipped = [];
        for (const file of files){
            if (!/\.css$/i.test(file.name) || file.size > MAX_SIZE){
                skipped.push(file.name);
                continue;
            }
            post("import", { name: file.name, content: await file.text() });
        }
        if (skipped.length) this.popup?.showError(`Not imported (only .css files up to 4 MB): ${skipped.join(", ")}`);
    }

    /**
     * @param {{requested: string, name: string, error?: string|null}} result
     */
    imported(result){
        if (result.error){
            this.popup?.showError(`Could not add ${result.requested}: ${result.error}`);
            return;
        }
        // nothing on yet: whatever was just added is what the player wants to see
        if (!this.active) this.activate(result.name);
        if (result.requested === this.openAfterImport){
            this.openAfterImport = null;
            this.load(result.name);
        }
        else if (!this.editing) this.load(result.name);
    }

    /**
     * @param {string} name
     */
    async rename(name){
        if (!this.popup) return;
        const value = await askText(this.popup.shadow, `Rename ${name}`, name, "Ends in .css");
        if (!value) return;
        const to = cssName(value);
        if (to === name) return;
        this.renaming = { from: name, to };
        post("rename", { from: name, to });
    }

    /**
     * @param {string} name
     */
    async remove(name){
        if (!this.popup) return;
        const sure = await askConfirm(this.popup.shadow, `Delete ${name}?`, "It goes to the recycle bin.", "Delete");
        if (!sure) return;
        // the list reply closes the editor, the changes go with the file. a failed delete keeps them
        post("delete", { name });
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

const manager = new CssManager();

export const open = () => manager.open();
