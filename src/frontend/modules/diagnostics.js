import html from "../components/diagnostics.html";
import { kute } from "../client.js";
import { highlight } from "./managers/editor.js";

/**
 * Diagnostics Report: the host collects, the player sees every entry and saves a .kutediag (a zip) into Downloads.
 * Only Krunker's game settings leave localStorage, never its tokens.
 */

const HOST_FEATURE = "diagnostics";
const KRUNKER_SETTING_PREFIX = "kro_setngss_";
// tens of thousands of spans make the preview sluggish, bigger files stay plain
const MAX_HIGHLIGHT_CHARS = 256 * 1024;

/**
 * @typedef {object} DiagnosticsEntry
 * @property {string} name
 * @property {"json"|"text"|"binary"} kind
 * @property {string} note
 * @property {number} bytes
 * @property {string} [text]
 * @property {boolean} [truncated]
 */

/**
 * @param {number} bytes
 * @return {string}
 */
function size(bytes){
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * @return {string} 2026-10-14
 */
function today(){
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * @return {{vendor: string, renderer: string}|null} the ANGLE string names the graphics backend
 */
function webglRenderer(){
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const result = info
        ? { vendor: String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)), renderer: String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) }
        : null;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return result;
}

/**
 * @return {Record<string, any>}
 */
function pagePart(){
    /** @type {Record<string, string|null>} */
    const krunker = {};
    for (let index = 0; index < localStorage.length; index++){
        const key = localStorage.key(index);
        if (key?.startsWith(KRUNKER_SETTING_PREFIX)) krunker[key] = localStorage.getItem(key);
    }
    /** @type {any} */
    let autodetect = null;
    try {
        autodetect = JSON.parse(localStorage.getItem("kute_autodetect") ?? "null");
    }
    catch {
        autodetect = null;
    }
    /** @type {{mode: string, map: string|null, custom: boolean}|null} */
    let activity = null;
    try {
        const { mode, map, custom } = window.getGameActivity();
        activity = { mode, map, custom };
    }
    catch {
        activity = null;
    }
    const { memory } = /** @type {any} */ (performance);
    return {
        date: today(),
        krunker,
        autodetect,
        page: {
            path: location.pathname,
            activity,
            userAgent: navigator.userAgent,
            threads: navigator.hardwareConcurrency,
            devicePixelRatio: window.devicePixelRatio,
            screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight },
            window: { width: window.innerWidth, height: window.innerHeight },
            webgl: webglRenderer(),
            jsHeapMb: memory ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : null,
            jsHeapLimitMb: memory ? Math.round(memory.jsHeapSizeLimit / 1024 / 1024) : null,
        },
    };
}

class Diagnostics {
    constructor(){
        /** @type {HTMLDivElement|null} */
        this.overlay = null;
        /** @type {ShadowRoot|null} */
        this.shadow = null;
        /** @type {DiagnosticsEntry[]} */
        this.entries = [];
        /** @type {Set<string>} */
        this.excluded = new Set();
        this.compressed = 0;
        /** @type {(event: MessageEvent) => void} */
        this.onMessage = (event) => this.receive(event.data);
        /** @type {(event: KeyboardEvent) => void} */
        this.onKey = (event) => {
            if (event.key === "Escape") this.close();
        };
        kute.diagnostics = { open: () => this.open() };
    }

    open(){
        if (!kute.hostFeatures?.includes(HOST_FEATURE)){
            kute.showNotification("The Diagnostics Report needs a newer Kute", false, 4);
            return;
        }
        if (this.overlay) return;
        this.entries = [];
        this.excluded.clear();

        this.overlay = document.createElement("div");
        this.overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        this.overlay.append(host);
        this.shadow = host.attachShadow({ mode: "open" });
        this.shadow.innerHTML = html;
        this.element("dgClose").onclick = () => this.close();
        this.element("dgSave").onclick = () => this.save();
        this.overlay.addEventListener("mousedown", (event) => {
            if (event.target === this.overlay) this.close();
        });
        document.addEventListener("keydown", this.onKey);
        window.chrome.webview.addEventListener("message", this.onMessage);
        document.body.append(this.overlay);

        window.chrome.webview.postMessage(`diagnostics-collect ${JSON.stringify(pagePart())}`);
    }

    close(){
        window.chrome.webview.removeEventListener("message", this.onMessage);
        document.removeEventListener("keydown", this.onKey);
        this.overlay?.remove();
        this.overlay = null;
        this.shadow = null;
        this.entries = [];
    }

    /**
     * @param {string} id
     * @return {HTMLElement}
     */
    element(id){
        return /** @type {HTMLElement} */ (this.shadow?.querySelector(`#${id}`));
    }

    /**
     * @param {any} data
     */
    receive(data){
        if (!this.shadow) return;
        if (data?.diagnostics){
            this.entries = data.diagnostics.entries ?? [];
            this.compressed = data.diagnostics.compressed ?? 0;
            this.element("dgSave").classList.remove("dgBusy");
            this.renderList();
            this.select(this.entries.find((entry) => entry.name !== "manifest.json")?.name ?? "manifest.json");
        }
        else if (data?.diagnosticsSaved){
            const { file, error } = data.diagnosticsSaved;
            this.element("dgSave").classList.remove("dgBusy");
            if (error){
                kute.showNotification(`Could not save the report: ${error}`, false, 5);
                return;
            }
            kute.showNotification(`Saved ${file} to your Downloads folder`, false, 5);
            this.close();
        }
    }

    renderList(){
        const list = this.element("dgEntries");
        list.replaceChildren();
        for (const entry of this.entries){
            const row = document.createElement("div");
            row.className = "dgEntry";
            row.dataset.name = entry.name;
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = !this.excluded.has(entry.name);
            // the manifest says what the file is, it always goes in
            box.disabled = entry.name === "manifest.json";
            box.onclick = (event) => {
                event.stopPropagation();
                if (box.checked) this.excluded.delete(entry.name);
                else this.excluded.add(entry.name);
                row.classList.toggle("dgOff", !box.checked);
                this.renderTotal();
            };
            const label = document.createElement("div");
            const name = document.createElement("span");
            name.className = "dgName";
            name.textContent = entry.name;
            const bytes = document.createElement("span");
            bytes.className = "dgSize";
            bytes.textContent = size(entry.bytes);
            label.append(name, bytes);
            row.append(box, label);
            row.onclick = () => this.select(entry.name);
            list.append(row);
        }
        this.renderTotal();
    }

    /**
     * @param {string} name
     */
    select(name){
        const entry = this.entries.find((candidate) => candidate.name === name);
        if (!entry) return;
        for (const row of this.element("dgEntries").querySelectorAll(".dgEntry")){
            row.classList.toggle("dgSelected", /** @type {HTMLElement} */ (row).dataset.name === name);
        }
        this.element("dgNote").textContent = entry.note;
        const text = this.element("dgText");
        if (entry.kind === "binary") text.textContent = `${entry.name}: ${size(entry.bytes)} of binary data, goes into the file as it is.`;
        else if (entry.kind === "json" && !entry.truncated && (entry.text ?? "").length <= MAX_HIGHLIGHT_CHARS) text.innerHTML = highlight(entry.text ?? "", "json");
        else text.textContent = entry.truncated ? `${entry.text}\n\n... (the preview ends here, the file holds all of it)` : (entry.text ?? "");
        text.scrollTop = 0;
    }

    renderTotal(){
        const included = this.entries.filter((entry) => !this.excluded.has(entry.name));
        const raw = included.reduce((sum, entry) => sum + entry.bytes, 0);
        const all = this.entries.reduce((sum, entry) => sum + entry.bytes, 0);
        const estimate = all > 0 ? (this.compressed * raw) / all : 0;
        this.element("dgTotal").textContent = `${included.length} of ${this.entries.length} files, about ${size(Math.round(estimate))} as a file`;
    }

    save(){
        this.element("dgSave").classList.add("dgBusy");
        window.chrome.webview.postMessage(`diagnostics-save ${JSON.stringify([...this.excluded])}`);
    }
}

export default new Diagnostics();
