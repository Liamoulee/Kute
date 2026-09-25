import { kute } from "../../client.js";
import html from "../../components/managers/swapper.html";
import { openManagerPopup, makeDropTarget, readBase64, askText, askConfirm, hostSupportsManagers, formatSize } from "./popup.js";
import { createEditorView, languageFor } from "./editor.js";

const TEXT_FILES = new Set(["css", "js", "mjs", "json", "txt", "html", "htm", "svg", "xml", "obj", "mtl", "glsl", "frag", "vert", "md", "csv"]);

// the host refuses more, and the editor gets slow long before
const MAX_EDIT_SIZE = 4 * 1024 * 1024;

/**
 * @param {string} path
 * @return {boolean}
 */
const isText = (path) => TEXT_FILES.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());

/**
 * @return {boolean}
 */
const hostSupportsEditor = () => kute.hostFeatures?.includes("swapper-editor") ?? false;

/**
 * @typedef {object} SwapperList What the host lists (swapper.rs, list())
 * @property {{ path: string, size: number }[]} files
 * @property {string[]} dirs
 * @property {string[]} seen Every krunker.io file the game requested this session
 * @property {boolean} enabled
 */

/**
 * @typedef {object} TreeFolder
 * @property {string} name
 * @property {string} path
 * @property {Map<string, TreeFolder>} folders
 * @property {{ name: string, path: string, size: number }[]} files
 */

// host message cap is 48 MB, this is that after base64
const MAX_FILE_SIZE = 32 * 1024 * 1024;

// game tree grows to thousands of files, cap search results
const MAX_SEARCH_ROWS = 400;

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
 * @param {string} icon
 * @param {string} title
 * @param {() => void} onClick
 * @param {string} [extraClass]
 * @return {HTMLElement}
 */
const iconButton = (icon, title, onClick, extraClass = "") => {
    const button = element("div", `iconBtn ${extraClass}`);
    button.title = title;
    button.append(element("span", "mi", icon));
    button.onclick = (event) => {
        event.stopPropagation();
        onClick();
    };
    return button;
};

/**
 * @param {string} path
 * @return {string}
 */
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

/**
 * @param {string} path
 * @return {string}
 */
const dirName = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * @param {{ path: string, size: number }[]} files
 * @param {string[]} dirs
 * @return {TreeFolder}
 */
const buildTree = (files, dirs) => {
    /** @type {TreeFolder} */
    const root = { name: "", path: "", folders: new Map(), files: [] };
    /**
     * @param {string} path
     * @return {TreeFolder}
     */
    const folderFor = (path) => {
        let node = root;
        for (const part of path.split("/").filter(Boolean)){
            let next = node.folders.get(part);
            if (!next){
                next = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: new Map(), files: [] };
                node.folders.set(part, next);
            }
            node = next;
        }
        return node;
    };
    for (const dir of dirs) folderFor(dir);
    for (const file of files) folderFor(dirName(file.path)).files.push({ name: baseName(file.path), path: file.path, size: file.size });
    return root;
};

/**
 * @param {TreeFolder} folder
 * @return {number}
 */
const countFiles = (folder) => folder.files.length + [...folder.folders.values()].reduce((sum, child) => sum + countFiles(child), 0);

class SwapperManager {
    constructor(){
        /** @type {import("./popup.js").ManagerPopup|null} */
        this.popup = null;
        /** @type {SwapperList|null} */
        this.list = null;
        /** @type {Set<string>} folders of the own tree the player closed */
        this.collapsedOwn = new Set();
        /** @type {Set<string>} folders of the game tree the player opened */
        this.expandedGame = new Set();
        this.search = "";
        this.changed = false;
        /** @type {((error: string|null) => void)|null} resolves once the host saved the current upload */
        this.uploadDone = null;
        /** @type {{ path: string, editor: import("./editor.js").CodeEditor, closeAfterSave: boolean }|null} */
        this.editing = null;
        /** @type {string|null} path of a read on its way */
        this.pendingRead = null;
        this.saving = false;
        this.forceClose = false;
    }

    open(){
        if (this.popup) return;
        if (!hostSupportsManagers()){
            window.chrome.webview.postMessage("open, swapper");
            kute.showNotification("This Kute version can only open the swapper folder. Update Kute for the swapper manager.", false, 6);
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
        const { shadow, signal } = this.popup;
        signal.addEventListener("abort", () => {
            this.popup = null;
            this.editing = null;
            this.pendingRead = null;
            this.saving = false;
            this.forceClose = false;
            // unblock a pending upload so its loop sees the popup is gone
            this.uploadDone?.(null);
            this.uploadDone = null;
        });
        /** @type {HTMLElement} */ (shadow.querySelector("#swFolder")).onclick = () => this.send("reveal", { path: "" });
        /** @type {HTMLElement} */ (shadow.querySelector("#swReload")).onclick = () => this.send("list", {});
        /** @type {HTMLElement} */ (shadow.querySelector("#swRefreshNow")).onclick = () => location.reload();
        /** @type {HTMLElement} */ (shadow.querySelector("#swNewFolder")).onclick = () => this.newFolder("");
        const newFile = /** @type {HTMLElement} */ (shadow.querySelector("#swNewFile"));
        if (!hostSupportsEditor()) newFile.style.display = "none";
        newFile.onclick = () => this.newFile("");
        makeDropTarget(/** @type {HTMLElement} */ (shadow.querySelector("#swOwnColumn")), (files) => this.drop("", files));
        const search = /** @type {HTMLInputElement} */ (shadow.querySelector("#swSearch"));
        search.value = this.search;
        search.oninput = () => {
            this.search = search.value.trim().toLowerCase();
            this.renderGame();
        };
        /** @type {HTMLElement} */ (shadow.querySelector("#swOwnTree")).textContent = "Loading...";
        this.send("list", {});
    }

    /**
     * @param {string} command
     * @param {object} payload
     */
    send(command, payload){
        window.chrome.webview.postMessage(`swapper-${command} ${JSON.stringify(payload)}`);
    }

    /**
     * A "swapper" folder dropped on root is a pack and gets unwrapped.
     *
     * @param {string} folder
     * @param {import("./popup.js").DroppedFile[]} files
     */
    async drop(folder, files){
        let dropped = files;
        if (!folder && dropped.every(({ path }) => path.toLowerCase().startsWith("swapper/"))){
            dropped = dropped.map(({ path, file }) => ({ path: path.slice("swapper/".length), file }));
        }
        await this.upload(dropped.map(({ path, file }) => ({ path: folder ? `${folder}/${path}` : path, file })));
    }

    /**
     * One file dropped on a game file takes its exact path.
     *
     * @param {string} gamePath
     * @param {import("./popup.js").DroppedFile[]} files
     */
    async replace(gamePath, files){
        if (!this.popup) return;
        if (files.length !== 1){
            this.popup.showError("Drop exactly one file onto a game file. Drop several onto a folder instead.");
            return;
        }
        const [{ file }] = files;
        /**
         * @param {string} name
         * @return {string}
         */
        const extension = (name) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
        if (extension(file.name) !== extension(gamePath)){
            const text = `${file.name} is saved as ${baseName(gamePath)}, the game will read it as .${extension(gamePath)}. Go ahead?`;
            if (!await askConfirm(this.popup.shadow, "Different file type", text, "Save anyway")) return;
        }
        await this.upload([{ path: gamePath, file }]);
    }

    /**
     * @param {{ path: string, file: File }[]} files
     */
    async upload(files){
        /** @type {string[]} */
        const problems = [];
        for (const { path, file } of files){
            if (!this.popup) return;
            if (file.size > MAX_FILE_SIZE){
                problems.push(`${path}: larger than 32 MB, put it in with Open swapper folder`);
                continue;
            }
            // one at a time so a big pack never piles up as base64 in memory
            const data = await readBase64(file);
            const error = await new Promise((resolve) => {
                this.uploadDone = resolve;
                this.send("upload", { path, data });
            });
            if (error) problems.push(error);
        }
        this.changed = true;
        // list once at the end, it rereads the folder and rebuilds the index
        this.send("list", {});
        if (problems.length) this.popup?.showError(problems.join("\n"));
    }

    /**
     * @param {any} data
     */
    receive(data){
        if (data.managerError) this.popup?.showError(data.managerError);
        if (data.swapperUploaded){
            const done = this.uploadDone;
            this.uploadDone = null;
            done?.(data.swapperUploaded.error ?? null);
        }
        if (data.swapperSource && data.swapperSource.path === this.pendingRead){
            this.pendingRead = null;
            if (typeof data.swapperSource.content === "string") this.showEditor(data.swapperSource.path, data.swapperSource.content);
            else this.popup?.showError(`${data.swapperSource.path} could not be read as text.`);
        }
        if (data.swapperWritten && this.saving){
            this.saving = false;
            if (data.swapperWritten.error) this.popup?.showError(data.swapperWritten.error);
            else if (this.editing){
                this.changed = true;
                this.editing.editor.markSaved();
                if (this.editing.closeAfterSave) this.closeEditor();
            }
        }
        if (!data.swapper) return;
        this.list = data.swapper;
        this.render();
    }

    /**
     * @param {string} selector
     * @return {HTMLElement}
     */
    get(selector){
        return /** @type {HTMLElement} */ (this.popup?.shadow.querySelector(selector));
    }

    render(){
        if (!this.popup || !this.list) return;
        const notice = this.get("#swNotice");
        const off = this.list.enabled === false;
        notice.hidden = !off && !this.changed;
        /** @type {HTMLElement} */ (notice.querySelector("span")).textContent = off
            ? "The swapper is switched off (Settings, Customization), none of these files are used."
            : "Changes apply after a page refresh.";
        this.renderOwn();
        this.renderGame();
    }

    renderOwn(){
        if (!this.list) return;
        const tree = this.get("#swOwnTree");
        tree.textContent = "";
        const root = buildTree(this.list.files, this.list.dirs);
        this.get("#swOwnCount").textContent = `${this.list.files.length} file${this.list.files.length === 1 ? "" : "s"}`;
        if (!this.list.files.length && !this.list.dirs.length){
            tree.append(element("div", "treeNote", "Nothing swapped yet. Drop a file onto one of the game files on the right, or drop a whole swapper pack here."));
            return;
        }

        const seen = new Map(this.list.seen.map((path) => [path.toLowerCase(), path]));
        /** @type {Map<string, string[]>} */
        const byName = new Map();
        for (const path of this.list.seen){
            const name = baseName(path).toLowerCase();
            byName.set(name, [...byName.get(name) ?? [], path]);
        }

        /**
         * @param {TreeFolder} folder
         * @param {number} depth
         */
        const walk = (folder, depth) => {
            for (const child of [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name))){
                const collapsed = this.collapsedOwn.has(child.path);
                const row = this.folderRow(child.name, depth, !collapsed, `${countFiles(child)}`);
                row.onclick = () => {
                    if (collapsed) this.collapsedOwn.delete(child.path);
                    else this.collapsedOwn.add(child.path);
                    this.renderOwn();
                };
                const actions = row.querySelector(".scriptActions");
                if (hostSupportsEditor()) actions?.append(iconButton("note_add", "New file inside", () => this.newFile(child.path)));
                actions?.append(
                    iconButton("create_new_folder", "New folder inside", () => this.newFolder(child.path)),
                    iconButton("drive_file_rename_outline", "Rename or move", () => this.move(child.path)),
                    iconButton("folder_open", "Open in Explorer", () => this.send("reveal", { path: child.path })),
                    iconButton("delete", "Delete (goes to the recycle bin)", () => this.remove(child.path), "danger"),
                );
                makeDropTarget(row, (files) => this.drop(child.path, files));
                tree.append(row);
                if (!collapsed) walk(child, depth + 1);
            }
            for (const file of [...folder.files].sort((a, b) => a.name.localeCompare(b.name))){
                tree.append(this.ownFileRow(file, depth, seen, byName));
            }
        };
        walk(root, 0);
    }

    /**
     * @param {string} name
     * @param {number} depth
     * @param {boolean} open
     * @param {string} detail
     * @return {HTMLElement}
     */
    folderRow(name, depth, open, detail){
        const row = element("div", "node folder");
        row.style.setProperty("--depth", String(depth));
        row.append(element("span", "mi", open ? "expand_more" : "chevron_right"), element("span", "mi kind", open ? "folder_open" : "folder"));
        row.append(element("span", "nodeName", name), element("span", "nodeSize", detail), element("div", "scriptActions"));
        return row;
    }

    /**
     * @param {{ name: string, path: string, size: number }} file
     * @param {number} depth
     * @param {Map<string, string>} seen
     * @param {Map<string, string[]>} byName
     * @return {HTMLElement}
     */
    ownFileRow(file, depth, seen, byName){
        const row = element("div", "node");
        row.style.setProperty("--depth", String(depth + 1));
        row.append(element("span", "mi", "description"), element("span", "nodeName", file.name), element("span", "nodeSize", formatSize(file.size)));

        const used = seen.get(file.path.toLowerCase());
        const elsewhere = (byName.get(file.name.toLowerCase()) ?? []).filter((path) => path.toLowerCase() !== file.path.toLowerCase());
        if (used){
            const state = element("span", "state ok", "Used");
            state.title = `The game loaded krunker.io/${used} this session, this file replaced it.`;
            row.append(state);
        }
        else if (elsewhere.length){
            const [target] = elsewhere;
            const state = element("span", "state warn", "Wrong folder?");
            state.title = `The game asks for this file as ${elsewhere.join(", ")}`;
            const fix = element("div", "btn small", "Move there");
            fix.title = `Move to ${target}`;
            fix.onclick = () => {
                this.changed = true;
                this.send("move", { from: file.path, to: target });
            };
            row.append(state, fix);
        }
        else {
            const state = element("span", "state", "Not requested");
            state.title = "The game did not ask for this path in this session. It may still come (another map, a skin), or the path does not match any game file.";
            row.append(state);
        }

        const actions = element("div", "scriptActions");
        if (hostSupportsEditor() && isText(file.path) && file.size <= MAX_EDIT_SIZE){
            actions.append(iconButton("edit", "Edit", () => this.edit(file.path)));
            row.ondblclick = () => this.edit(file.path);
        }
        actions.append(
            iconButton("drive_file_rename_outline", "Rename or move", () => this.move(file.path)),
            iconButton("folder_open", "Show in Explorer", () => this.send("reveal", { path: file.path })),
            iconButton("delete", "Delete (goes to the recycle bin)", () => this.remove(file.path), "danger"),
        );
        row.append(actions);
        makeDropTarget(row, (files) => this.drop(dirName(file.path), files));
        return row;
    }

    renderGame(){
        if (!this.list || !this.popup) return;
        const tree = this.get("#swGameTree");
        tree.textContent = "";
        const { seen } = this.list;
        this.get("#swGameCount").textContent = `${seen.length} loaded this session`;
        const own = new Set(this.list.files.map((file) => file.path.toLowerCase()));

        if (!seen.length){
            tree.append(element("div", "treeNote", "The game has not loaded any files yet. Play a round or open a menu, then Reload list."));
            return;
        }

        /**
         * @param {string} path
         * @param {number} depth
         * @return {HTMLElement}
         */
        const fileRow = (path, depth) => {
            const row = element("div", "node");
            row.style.setProperty("--depth", String(depth));
            row.title = `krunker.io/${path}\nDrop a file here to replace it`;
            row.append(element("span", "mi", "insert_drive_file"), element("span", "nodeName", depth ? baseName(path) : path));
            if (own.has(path.toLowerCase())) row.append(element("span", "swapped", "swapped"));
            if (hostSupportsEditor() && isText(path)){
                const swapped = this.list?.files.find((file) => file.path.toLowerCase() === path.toLowerCase());
                const actions = element("div", "scriptActions");
                if (swapped) actions.append(iconButton("edit", "Edit your swap", () => this.edit(swapped.path)));
                else actions.append(iconButton("edit_note", "Edit a copy, saving it swaps the file", () => this.editCopy(path)));
                row.append(actions);
            }
            makeDropTarget(row, (files) => this.replace(path, files));
            return row;
        };

        if (this.search){
            const matches = seen.filter((path) => path.toLowerCase().includes(this.search));
            for (const path of matches.slice(0, MAX_SEARCH_ROWS)) tree.append(fileRow(path, 0));
            if (!matches.length) tree.append(element("div", "treeNote", "No game file matches."));
            if (matches.length > MAX_SEARCH_ROWS) tree.append(element("div", "treeNote", `${matches.length - MAX_SEARCH_ROWS} more, search for something longer.`));
            return;
        }

        const root = buildTree(seen.map((path) => ({ path, size: 0 })), []);
        /**
         * @param {TreeFolder} folder
         * @param {number} depth
         */
        const walk = (folder, depth) => {
            for (const child of [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name))){
                const open = this.expandedGame.has(child.path);
                const row = this.folderRow(child.name, depth, open, `${countFiles(child)}`);
                row.title = "Drop files here to put them into this folder";
                row.onclick = () => {
                    if (open) this.expandedGame.delete(child.path);
                    else this.expandedGame.add(child.path);
                    this.renderGame();
                };
                makeDropTarget(row, (files) => this.drop(child.path, files));
                tree.append(row);
                if (open) walk(child, depth + 1);
            }
            for (const file of [...folder.files].sort((a, b) => a.name.localeCompare(b.name))) tree.append(fileRow(file.path, depth + 1));
        };
        walk(root, 0);
    }

    /**
     * @param {string} parent
     */
    async newFile(parent){
        if (!this.popup) return;
        const answer = await askText(this.popup.shadow, "New file", parent ? `${parent}/new.css` : "css/new.css", "A path inside the swapper folder, the same path the game loads the file from");
        if (!answer) return;
        const path = answer.replace(/^\/+/, "");
        if (this.list?.files.some((file) => file.path.toLowerCase() === path.toLowerCase())){
            this.popup.showError(`${path} already exists, edit it instead.`);
            return;
        }
        this.showEditor(path, "", true);
    }

    /**
     * @param {string} path
     */
    edit(path){
        if (this.pendingRead || this.editing) return;
        this.pendingRead = path;
        this.send("read", { path });
    }

    /**
     * Starts from the game's own file, nothing is written before Save.
     *
     * @param {string} path
     */
    async editCopy(path){
        if (this.pendingRead || this.editing) return;
        this.pendingRead = path;
        let content = null;
        for (const origin of ["https://krunker.io", "https://assets.krunker.io"]){
            try {
                const response = await fetch(`${origin}/${path}`);
                if (response.ok){
                    content = await response.text();
                    break;
                }
            }
            catch {
                // next origin
            }
        }
        if (this.pendingRead !== path) return;
        this.pendingRead = null;
        if (content === null){
            this.popup?.showError(`Could not download krunker.io/${path}, starting with an empty file.`);
            content = "";
        }
        this.showEditor(path, content, true);
    }

    /**
     * @param {string} path
     * @param {string} content
     * @param {boolean} [isNew] Nothing on disk yet
     */
    showEditor(path, content, isNew = false){
        if (!this.popup) return;
        const holder = this.get("#swEditor");
        this.get(".swapColumns").style.display = "none";
        holder.style.display = "";
        const { editor } = createEditorView(holder, {
            title: path,
            content,
            language: languageFor(path),
            isNew,
            onSave: (closeAfter) => {
                if (!this.editing || this.saving) return;
                this.saving = true;
                this.editing.closeAfterSave = closeAfter;
                this.send("write", { path, content: this.editing.editor.getValue() });
            },
            onClose: () => this.leaveEditor(),
        });
        this.editing = { path, editor, closeAfterSave: false };
    }

    async leaveEditor(){
        if (!this.editing || !this.popup) return;
        if (this.editing.editor.isDirty()){
            const discard = await askConfirm(this.popup.shadow, "Unsaved changes", "Close the editor and throw the changes away?", "Discard");
            if (!discard) return;
        }
        this.closeEditor();
    }

    closeEditor(){
        this.editing = null;
        if (!this.popup) return;
        const holder = this.get("#swEditor");
        holder.textContent = "";
        holder.style.display = "none";
        this.get(".swapColumns").style.display = "";
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

    /**
     * @param {string} parent
     */
    async newFolder(parent){
        if (!this.popup) return;
        const answer = await askText(this.popup.shadow, "New folder", parent ? `${parent}/` : "textures", "A path inside the swapper folder, for example textures/weapons");
        if (!answer) return;
        this.send("mkdir", { path: answer });
    }

    /**
     * @param {string} path
     */
    async move(path){
        if (!this.popup) return;
        const answer = await askText(this.popup.shadow, "Rename or move", path, "The new path inside the swapper folder. Change the folders in front to move it.");
        if (!answer || answer === path) return;
        this.changed = true;
        this.send("move", { from: path, to: answer });
    }

    /**
     * @param {string} path
     */
    async remove(path){
        if (!this.popup) return;
        const sure = await askConfirm(this.popup.shadow, `Delete ${baseName(path)}?`, "It goes to the recycle bin, so you can still get it back.", "Delete");
        if (!sure) return;
        this.changed = true;
        this.send("delete", { path });
    }
}

const manager = new SwapperManager();

export const open = () => manager.open();
