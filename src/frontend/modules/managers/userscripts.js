import { kute } from "../../client.js";
import html from "../../components/managers/userscripts.html";
import { registry } from "./registry.js";
import { openManagerPopup, makeDropTarget, askText, askConfirm, hostSupportsManagers, formatSize } from "./popup.js";
import { createEditorView } from "./editor.js";

/**
 * @typedef {object} ListedScript One script as the host lists it (userscripts.rs, list())
 * @property {string} key
 * @property {string} group
 * @property {string} file
 * @property {boolean} enabled
 * @property {string} runAt
 * @property {number} priority
 * @property {Record<string, string>} meta
 * @property {number} size
 */

/**
 * @typedef {object} ListedGroup
 * @property {string} id
 * @property {string} label
 * @property {string} runs
 * @property {ListedScript[]} scripts
 */

/**
 * @typedef {object} OpenEditor
 * @property {string} group
 * @property {string} file
 * @property {import("./editor.js").CodeEditor} editor
 * @property {boolean} closeAfterSave
 */

// same cap as userscripts.rs
const MAX_SCRIPT_SIZE = 4 * 1024 * 1024;

const TEMPLATE = `// ==UserScript==
// @name        {{name}}
// @author
// @version     1.0
// @desc
// @run-at      document-end
// ==/UserScript==

this._console.log("{{name}} is running");

// undo everything the script did, so it can be switched off without a refresh
this.unload = () => {};

return this;
`;

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @return {HTMLElement}
 */
const element = (tag, className = "", text = "") => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text) created.textContent = text;
    return created;
};

/**
 * @param {string} icon Material icon name
 * @param {string} title
 * @param {() => void} onClick
 * @param {string} [extraClass]
 * @return {HTMLElement}
 */
const iconButton = (icon, title, onClick, extraClass = "") => {
    const button = element("div", `iconBtn ${extraClass}`);
    button.title = title;
    button.append(element("span", "mi", icon));
    button.onclick = onClick;
    return button;
};

class UserscriptManager {
    constructor(){
        /** @type {import("./popup.js").ManagerPopup|null} */
        this.popup = null;
        /** @type {ListedGroup[]} */
        this.groups = [];
        /** @type {Set<string>} */
        this.openSettings = new Set();
        /** @type {OpenEditor|null} */
        this.editing = null;
        /** @type {string|null} key of a read on its way */
        this.pendingRead = null;
        /** @type {{ closeAfter: boolean }|null} */
        this.pendingSave = null;
        this.needsRefresh = false;
        this.renderQueued = false;
        this.forceClose = false;
        /** @type {Map<string, number>} debounced preference saves per script */
        this.prefsTimers = new Map();

        if (registry) registry.onChange = () => this.queueRender();
    }

    open(){
        if (this.popup) return;
        if (!hostSupportsManagers()){
            window.chrome.webview.postMessage("open, userscripts");
            kute.showNotification("This Kute version can only open the scripts folder. Update Kute for the script manager.", false, 6);
            return;
        }

        this.popup = openManagerPopup(html, {
            onMessage: (data) => this.receive(data),
            canClose: () => this.canClose(),
            onEscape: () => {
                if (!this.editing) return false;
                this.leaveEditor();
                return true;
            },
        });
        this.popup.signal.addEventListener("abort", () => {
            this.popup = null;
            this.editing = null;
            this.forceClose = false;
        });
        const { shadow } = this.popup;
        /** @type {HTMLElement} */ (shadow.querySelector("#usFolder")).onclick = () => this.send("reveal", {});
        /** @type {HTMLElement} */ (shadow.querySelector("#usRefreshNow")).onclick = () => location.reload();
        this.body().textContent = "Loading...";
        this.send("list", {});
    }

    /**
     * @param {string} command
     * @param {object} payload
     */
    send(command, payload){
        window.chrome.webview.postMessage(`scripts-${command} ${JSON.stringify(payload)}`);
    }

    /**
     * @return {HTMLElement}
     */
    body(){
        return /** @type {HTMLElement} */ (this.popup?.shadow.querySelector("#usBody"));
    }

    /**
     * @param {any} data
     */
    receive(data){
        if (data.managerError){
            this.popup?.showError(data.managerError);
            if (this.pendingSave) this.pendingSave = null;
        }
        if (data.userscripts){
            this.groups = data.userscripts.groups ?? [];
            if (this.pendingSave && this.editing){
                const { closeAfter } = this.pendingSave;
                this.pendingSave = null;
                this.editing.editor.markSaved();
                this.needsRefresh = true;
                if (closeAfter) this.editing = null;
            }
            if (!this.editing) this.render();
            this.updateNotice();
        }
        if (data.userscriptSource && data.userscriptSource.key === this.pendingRead){
            this.pendingRead = null;
            const script = this.findScript(data.userscriptSource.key);
            if (script && typeof data.userscriptSource.content === "string"){
                this.showEditor(script.group, script.file, data.userscriptSource.content);
            }
            else this.popup?.showError("The script could not be read.");
        }
    }

    /**
     * @param {string} key
     * @return {ListedScript|undefined}
     */
    findScript(key){
        for (const group of this.groups){
            const script = group.scripts.find((candidate) => candidate.key === key);
            if (script) return script;
        }
        return undefined;
    }

    /**
     * @param {string} key
     * @return {ScriptEntry|undefined}
     */
    entryFor(key){
        return registry?.entries?.find((entry) => entry.key === key);
    }

    queueRender(){
        if (!this.popup || this.editing || this.renderQueued) return;
        this.renderQueued = true;
        queueMicrotask(() => {
            this.renderQueued = false;
            if (this.popup && !this.editing) this.render();
        });
    }

    updateNotice(){
        const notice = /** @type {HTMLElement|null} */ (this.popup?.shadow.querySelector("#usRefresh"));
        if (!notice) return;
        const off = kute.settings?.data?.userscripts === false;
        notice.hidden = !this.needsRefresh && !off;
        /** @type {HTMLElement} */ (notice.querySelector("span")).textContent = off
            ? "Userscripts are switched off (Settings, Customization). Nothing here runs until they are on again."
            : "Some changes apply after a page refresh.";
    }

    render(){
        const body = this.body();
        if (!body || !this.popup) return;
        body.textContent = "";
        for (const group of this.groups) body.append(this.renderGroup(group));
    }

    /**
     * @param {ListedGroup} group
     * @return {HTMLElement}
     */
    renderGroup(group){
        const section = element("div", "group");
        const head = element("div", "groupHead");
        head.append(element("div", "groupTitle", group.label), element("div", "groupRuns", `runs in ${group.runs}`));
        const create = element("div", "btn small");
        create.append(element("span", "mi", "add"), "New script");
        create.onclick = () => this.createScript(group.id);
        head.append(create);
        section.append(head);

        if (group.scripts.length === 0) section.append(element("div", "empty", "No scripts yet."));
        for (const script of group.scripts) this.renderScript(section, group, script);

        section.append(element("div", "dropZone", `Drop .js files here to add them to ${group.label}`));
        makeDropTarget(section, (files) => this.importFiles(group, files));
        return section;
    }

    /**
     * @param {ListedGroup} group
     * @param {import("./popup.js").DroppedFile[]} files
     */
    async importFiles(group, files){
        if (!this.popup) return;
        /** @type {string[]} */
        const problems = [];
        const scripts = files.filter(({ file }) => {
            if (!/\.js$/i.test(file.name)) problems.push(`${file.name}: not a .js file`);
            else if (file.size > MAX_SCRIPT_SIZE) problems.push(`${file.name}: larger than 4 MB`);
            else return true;
            return false;
        });
        const existing = new Set(group.scripts.map((script) => script.file.toLowerCase()));
        const replaced = scripts.filter(({ file }) => existing.has(file.name.toLowerCase())).map(({ file }) => file.name);
        if (replaced.length){
            const text = `${replaced.join(", ")} already exist in ${group.label}. Replace them with the dropped files?`;
            if (!await askConfirm(this.popup.shadow, "Replace scripts?", text, "Replace")) return;
        }
        for (const { file } of scripts){
            this.send("write", { group: group.id, file: file.name, content: await file.text(), noList: true });
        }
        // list once, listing parses every header
        this.send("list", {});
        if (scripts.length) this.needsRefresh = true;
        this.updateNotice();
        if (problems.length) this.popup?.showError(problems.join("\n"));
    }

    /**
     * @param {ListedScript} script
     * @param {ScriptEntry|undefined} entry
     * @param {boolean} social
     * @return {[string, string, string]} label, class, tooltip
     */
    stateOf(script, entry, social){
        if (entry?.state === "error") return ["Error", "bad", entry.error];
        if (social || !registry) return script.enabled ? ["On", "ok", ""] : ["Off", "", ""];
        if (script.enabled){
            if (entry?.state === "running") return ["Running", "ok", ""];
            if (entry?.state === "waiting") return ["Starting", "ok", "Starts once the page has loaded"];
            return ["After refresh", "warn", "On, starts with the next page load"];
        }
        if (entry?.state === "running") return ["Until refresh", "warn", "This script has no unload, it stops with the next page load"];
        return ["Off", "", ""];
    }

    /**
     * @param {HTMLElement} section
     * @param {ListedGroup} group
     * @param {ListedScript} script
     */
    renderScript(section, group, script){
        const social = group.id !== "game";
        const entry = social ? undefined : this.entryFor(script.key);
        const meta = entry?.meta ?? script.meta;
        const row = element("div", "scriptRow");

        const toggle = element("div", `toggle${script.enabled ? " on" : ""}`);
        toggle.title = script.enabled ? "Turn off" : "Turn on";
        toggle.onclick = () => this.toggle(script, entry, social);

        const info = element("div", "scriptInfo");
        const name = element("div", "scriptName", meta.name || script.file);
        if (meta.version) name.append(element("span", "version", `v${meta.version}`));
        if (meta.author) name.append(element("span", "author", `by ${meta.author}`));
        info.append(name);
        const details = [meta.desc, meta.name ? script.file : "", formatSize(script.size)].filter(Boolean).join("  ·  ");
        info.append(element("div", "scriptDesc", details));
        info.title = [meta.desc, `${script.file}, ${script.runAt}${script.priority ? `, priority ${script.priority}` : ""}`].filter(Boolean).join("\n");

        const [label, stateClass, tooltip] = this.stateOf(script, entry, social);
        const state = element("div", `state ${stateClass}`, label);
        if (tooltip) state.title = tooltip;

        const actions = element("div", "scriptActions");
        if (entry?.settings && Object.keys(entry.settings).length){
            actions.append(iconButton("tune", "Script settings", () => {
                if (this.openSettings.has(script.key)) this.openSettings.delete(script.key);
                else this.openSettings.add(script.key);
                this.render();
            }));
        }
        actions.append(
            iconButton("edit", "Edit", () => {
                this.pendingRead = script.key;
                this.send("read", { key: script.key });
            }),
            iconButton("swap_horiz", `Move to ${social ? "Game" : "Social"}`, () => this.send("move", { key: script.key, group: social ? "game" : "social" })),
            iconButton("folder_open", "Show in folder", () => this.send("reveal", { key: script.key })),
            iconButton("delete", "Delete (goes to the recycle bin)", () => this.deleteScript(script, entry), "danger"),
        );

        row.append(toggle, info, state, actions);
        section.append(row);

        if (entry?.settings && this.openSettings.has(script.key)) section.append(this.renderSettings(script, entry));
    }

    /**
     * @param {ListedScript} script
     * @param {ScriptEntry|undefined} entry
     * @param {boolean} social
     */
    toggle(script, entry, social){
        script.enabled = !script.enabled;
        this.send("toggle", { key: script.key, enabled: script.enabled });
        if (social){
            // social scripts pick it up on the next popup
        }
        else if (!entry || !registry){
            if (script.enabled || kute.settings?.data?.userscripts !== false) this.needsRefresh = true;
        }
        else if (script.enabled){
            entry.start();
            // a script that failed halfway needs a refresh, the runner won't restart it
            if (entry.tainted || (entry.state !== "running" && entry.state !== "waiting" && entry.state !== "error")) this.needsRefresh = true;
        }
        else if (!entry.stop()) this.needsRefresh = true;
        this.updateNotice();
        this.render();
    }

    /**
     * @param {ListedScript} script
     * @param {ScriptEntry|undefined} entry
     */
    async deleteScript(script, entry){
        if (!this.popup) return;
        const sure = await askConfirm(this.popup.shadow, `Delete ${script.file}?`, "It goes to the recycle bin, so you can still get it back.", "Delete");
        if (!sure) return;
        if (entry && !entry.stop() && entry.state === "running") this.needsRefresh = true;
        this.send("delete", { key: script.key });
    }

    /**
     * @param {string} group
     */
    async createScript(group){
        if (!this.popup) return;
        const answer = await askText(this.popup.shadow, "New script", "my-script.js", "The file name. It ends up in the scripts folder of this group.");
        if (!answer) return;
        const file = /\.js$/i.test(answer) ? answer : `${answer}.js`;
        const exists = this.groups.some((candidate) => candidate.id === group && candidate.scripts.some((script) => script.file.toLowerCase() === file.toLowerCase()));
        if (exists){
            this.popup.showError(`${file} already exists in this group.`);
            return;
        }
        this.showEditor(group, file, TEMPLATE.replaceAll("{{name}}", file.replace(/\.js$/i, "")), true);
    }

    /**
     * @param {ListedScript} script
     * @param {ScriptEntry} entry
     * @return {HTMLElement}
     */
    renderSettings(script, entry){
        const panel = element("div", "scriptSettings");
        const settings = entry.settings ?? {};

        // debounced, sliders fire per pixel
        const save = () => {
            clearTimeout(this.prefsTimers.get(script.key));
            this.prefsTimers.set(script.key, setTimeout(() => {
                this.prefsTimers.delete(script.key);
                const prefs = Object.fromEntries(Object.entries(settings).map(([key, setting]) => [key, setting.value]));
                this.send("prefs", { key: script.key, prefs });
            }, 300));
        };
        /**
         * @param {string} key
         * @param {any} value
         */
        const change = (key, value) => {
            entry.setPref(key, value);
            save();
        };

        for (const [key, setting] of Object.entries(settings)){
            const row = element("div", "settingRow");
            const label = element("div", "settingLabel", setting.title || key);
            if (setting.desc) label.append(element("small", "", setting.desc));
            row.append(label, this.settingControl(key, setting, change));
            panel.append(row);
        }
        return panel;
    }

    /**
     * @param {string} key
     * @param {ScriptSetting} setting
     * @param {(key: string, value: any) => void} change
     * @return {HTMLElement}
     */
    settingControl(key, setting, change){
        switch (setting.type){
            case "bool": {
                const toggle = element("div", `toggle${setting.value ? " on" : ""}`);
                toggle.onclick = () => {
                    change(key, !setting.value);
                    toggle.classList.toggle("on", Boolean(setting.value));
                };
                return toggle;
            }
            case "num": {
                const wrap = element("div");
                wrap.style.cssText = "display:flex;gap:.6em;align-items:center";
                const number = /** @type {HTMLInputElement} */ (element("input"));
                number.type = "number";
                number.style.width = "90px";
                number.value = String(setting.value);
                if (setting.min !== undefined) number.min = String(setting.min);
                if (setting.max !== undefined) number.max = String(setting.max);
                number.step = String(setting.step ?? "any");
                if (setting.min !== undefined && setting.max !== undefined){
                    const range = /** @type {HTMLInputElement} */ (element("input"));
                    range.type = "range";
                    range.min = String(setting.min);
                    range.max = String(setting.max);
                    range.step = String(setting.step ?? "any");
                    range.value = String(setting.value);
                    range.oninput = () => {
                        number.value = range.value;
                        change(key, Number(range.value));
                    };
                    number.onchange = () => {
                        range.value = number.value;
                    };
                    wrap.append(range);
                }
                number.addEventListener("change", () => {
                    if (number.value !== "" && Number.isFinite(Number(number.value))) change(key, Number(number.value));
                });
                wrap.append(number);
                return wrap;
            }
            case "sel": {
                const select = /** @type {HTMLSelectElement} */ (element("select"));
                for (const option of setting.opts ?? []){
                    const item = /** @type {HTMLOptionElement} */ (element("option", "", String(option)));
                    item.value = String(option);
                    item.selected = option === setting.value;
                    select.append(item);
                }
                select.onchange = () => {
                    const picked = (setting.opts ?? []).find((option) => String(option) === select.value);
                    change(key, picked ?? select.value);
                };
                return select;
            }
            case "color": {
                const color = /** @type {HTMLInputElement} */ (element("input"));
                color.type = "color";
                color.value = String(setting.value);
                color.onchange = () => change(key, color.value);
                return color;
            }
            case "text": {
                const text = /** @type {HTMLInputElement} */ (element("input"));
                text.type = "text";
                text.value = String(setting.value ?? "");
                text.onchange = () => change(key, text.value);
                return text;
            }
            case "keybind": {
                /**
                 * @param {any} bind
                 * @return {string}
                 */
                const describe = (bind) => [bind?.ctrl && "Ctrl", bind?.alt && "Alt", bind?.shift && "Shift", bind?.key || "none"].filter(Boolean).join(" + ");
                const button = element("div", "btn small", describe(setting.value));
                button.onclick = () => {
                    button.textContent = "Press a key...";
                    /**
                     * @param {KeyboardEvent} event
                     */
                    const listener = (event) => {
                        if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
                        event.preventDefault();
                        event.stopPropagation();
                        window.removeEventListener("keydown", listener, true);
                        const bind = { key: event.key.toLowerCase(), ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey };
                        change(key, bind);
                        button.textContent = describe(bind);
                    };
                    window.addEventListener("keydown", listener, true);
                };
                return button;
            }
            default:
                return element("div", "scriptFile", `unsupported type "${setting.type}"`);
        }
    }

    /**
     * @param {string} group
     * @param {string} file
     * @param {string} content
     * @param {boolean} [isNew]
     */
    showEditor(group, file, content, isNew = false){
        const body = this.body();
        if (!body) return;
        const { editor } = createEditorView(body, {
            title: file,
            content,
            language: "js",
            isNew,
            onSave: (closeAfter) => {
                if (!this.editing) return;
                this.pendingSave = { closeAfter };
                this.editing.closeAfterSave = closeAfter;
                this.send("write", { group, file, content: this.editing.editor.getValue() });
            },
            onClose: () => this.leaveEditor(),
        });
        this.editing = { group, file, editor, closeAfterSave: false };
    }

    async leaveEditor(){
        if (!this.editing || !this.popup) return;
        if (this.editing.editor.isDirty()){
            const discard = await askConfirm(this.popup.shadow, "Unsaved changes", "Close the editor and throw the changes away?", "Discard");
            if (!discard) return;
        }
        this.editing = null;
        this.render();
    }

    /**
     * @return {boolean}
     */
    canClose(){
        if (this.forceClose || !this.editing?.editor.isDirty() || !this.popup) return true;
        askConfirm(this.popup.shadow, "Unsaved changes", "Close and throw the changes away?", "Discard").then((discard) => {
            if (!discard) return;
            this.forceClose = true;
            this.popup?.close();
        });
        return false;
    }
}

const manager = new UserscriptManager();

export const open = () => manager.open();
