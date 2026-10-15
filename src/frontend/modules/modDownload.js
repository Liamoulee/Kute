import { kute } from "../client.js";

/**
 * A download button on every mod in Krunker's Mods window, next to Load and the star. The zip goes through the page
 * (user-assets.krunker.io allows krunker.io, dropbox any origin) and a blob download, which the host saves into
 * Downloads without asking, so this works on every exe.
 */

const BUTTON_ATTR = "data-kute-mod";
const MAX_BYTES = 300 * 1024 * 1024;
// krunker draws a download button here by itself for its own client (ClientSession.downloadPack), never twice
const KRUNKER_DOWNLOAD = "[onclick^=\"downloadPack\"]";
const LIST_ICON_STYLE = "font-size:70px;color:#fff;";
// krunker styles #bigMFeatPBtn by id, these are its computed values with kute's accent as the border
const FEATURED_STYLE = "position:absolute;right:30px;bottom:92px;box-sizing:content-box;width:240px;height:37px;padding:10px 6px 6px;"
    + "border:3px solid #35e0e8;border-radius:6px;background:rgba(0,0,0,0.6);color:#fff;font-size:21px;text-align:center;cursor:pointer;";
const FEATURED_ICON_STYLE = "font-size:32px;color:#fff;vertical-align:top;margin-top:-3px;margin-left:5px;";
const STATE_COLOR = { busy: "#777", done: "#35e0e8", failed: "#ff7a7a" };

/**
 * loadUserMod("name","url","id","creator",thumb): list cards quote with &quot;, the featured card with backticks
 *
 * @param {string} onclick
 * @return {{name: string, url: string}|null}
 */
function parseLoad(onclick){
    const match = /loadUserMod\(\s*(["`])(.*?)\1\s*,\s*(["`])(.*?)\3/.exec(onclick);
    return match ? { name: match[2], url: match[4] } : null;
}

/**
 * krunker's asset hosts and dropbox only, a mod may link anywhere. dropbox share pages are html, krunker loads the
 * file from dropboxusercontent the same way (and that host allows any origin)
 *
 * @param {string} url
 * @return {string|null}
 */
function zipUrl(url){
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return null;
        if (parsed.hostname === "krunker.io" || parsed.hostname.endsWith(".krunker.io")) return parsed.href;
        if (parsed.hostname === "dropbox.com" || parsed.hostname === "www.dropbox.com"){
            parsed.hostname = "dl.dropboxusercontent.com";
            parsed.search = "";
            return parsed.href;
        }
        return null;
    }
    catch {
        return null;
    }
}

/**
 * @param {string} name
 * @return {string}
 */
function fileName(name){
    const safe = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim().replace(/[ .]+$/, "").slice(0, 80);
    return `${safe || "mod"}.zip`;
}

/**
 * @param {string} url
 * @return {Promise<Blob>}
 */
async function fetchZip(url){
    const response = await fetch(url);
    // old dropbox links answer 403 once the creator deleted the file, krunker cannot load those either
    if (response.status === 403 || response.status === 404) throw new Error("This mod's file is gone, its creator removed it");
    if (!response.ok) throw new Error(`The mod server answered ${response.status}`);
    if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("That mod is too large");
    const blob = await response.blob();
    if (blob.size > MAX_BYTES) throw new Error("That mod is too large");
    const magic = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (magic[0] !== 0x50 || magic[1] !== 0x4b) throw new Error("That mod is not a zip file");
    return blob;
}

/**
 * @param {Blob} blob
 * @param {string} name
 */
function save(blob, name){
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    // the download has its own copy once it started
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

/**
 * @param {HTMLElement} button
 * @param {HTMLElement} icon
 * @param {string} modName
 * @param {string} url
 */
function arm(button, icon, modName, url){
    let busy = false;
    button.addEventListener("click", (event) => {
        // the list card loads the mod on a click that reaches it
        event.stopPropagation();
        if (busy) return;
        busy = true;
        icon.style.color = STATE_COLOR.busy;
        icon.textContent = "hourglass_top";
        const name = fileName(modName);
        fetchZip(url)
            .then((blob) => {
                save(blob, name);
                icon.style.color = STATE_COLOR.done;
                icon.textContent = "download_done";
                kute.showNotification(`Saved ${name} to your Downloads folder`, false, 4);
            })
            .catch((/** @type {Error} */ error) => {
                icon.style.color = STATE_COLOR.failed;
                icon.textContent = "error_outline";
                // fetch rejects with a TypeError when the network fails, the rest are ours
                kute.showNotification(error instanceof TypeError ? "Could not download the mod" : error.message, false, 4);
            })
            .finally(() => {
                busy = false;
            });
    });
}

/**
 * @param {string} style
 * @return {HTMLSpanElement}
 */
function makeIcon(style){
    const icon = document.createElement("span");
    icon.className = "material-icons";
    icon.style.cssText = style;
    icon.textContent = "download";
    return icon;
}

class ModDownload {
    constructor(){
        /** @type {ReturnType<typeof setTimeout>|null} */
        this.pending = null;
        // krunker rebuilds the window's html on every tab and page, a burst of records ends in one scan
        this.observer = new MutationObserver(() => {
            if (this.pending === null) this.pending = setTimeout(() => this.scan(), 150);
        });
        const menu = document.getElementById("menuWindow");
        if (!menu) return;
        this.observer.observe(menu, { childList: true, subtree: true });
        this.scan();
    }

    scan(){
        this.pending = null;
        const menu = document.getElementById("menuWindow");
        if (!menu) return;
        /** @type {[Element, HTMLElement[]][]} */
        const additions = [];
        for (const load of menu.querySelectorAll(".mapActionB[onclick^=\"loadUserMod\"]")){
            const holder = load.parentElement;
            if (!holder || holder.querySelector(`[${BUTTON_ATTR}], ${KRUNKER_DOWNLOAD}`)) continue;
            const mod = parseLoad(load.getAttribute("onclick") ?? "");
            const url = mod && zipUrl(mod.url);
            if (mod && url) additions.push([holder, this.listButton(mod.name, url)]);
        }
        const featured = document.getElementById("bigMFeatPBtn");
        const card = featured?.parentElement;
        if (featured && card && !card.querySelector(`[${BUTTON_ATTR}]`)){
            const mod = parseLoad(featured.getAttribute("onclick") ?? "");
            const url = mod && zipUrl(mod.url);
            if (mod && url) additions.push([card, [this.featuredButton(mod.name, url)]]);
        }
        if (additions.length === 0) return;
        // our own inserts would schedule another scan
        this.observer.disconnect();
        for (const [parent, elements] of additions) parent.append(...elements);
        this.observer.observe(menu, { childList: true, subtree: true });
    }

    /**
     * krunker's own markup for that button, so it sits in the card's hover bar like Load and the star
     *
     * @param {string} modName
     * @param {string} url
     * @return {HTMLElement[]}
     */
    listButton(modName, url){
        const separator = document.createElement("div");
        separator.className = "mapActionSep";
        separator.setAttribute(BUTTON_ATTR, "");
        const button = document.createElement("div");
        button.className = "mapActionB";
        button.title = "Download";
        button.setAttribute(BUTTON_ATTR, "");
        const icon = makeIcon(LIST_ICON_STYLE);
        button.append(icon);
        arm(button, icon, modName, url);
        return [separator, button];
    }

    /**
     * the big card on top, a box like its Load Mod right above it
     *
     * @param {string} modName
     * @param {string} url
     * @return {HTMLElement}
     */
    featuredButton(modName, url){
        const button = document.createElement("div");
        button.setAttribute(BUTTON_ATTR, "");
        button.style.cssText = FEATURED_STYLE;
        const icon = makeIcon(FEATURED_ICON_STYLE);
        button.append("Download ", icon);
        arm(button, icon, modName, url);
        return button;
    }
}

export default new ModDownload();
