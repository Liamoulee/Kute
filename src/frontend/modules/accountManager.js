import { kute } from "../client.js";
import { getElement, getInput, checkCompMode, waitForElement, request } from "../utils.js";
import { confirmPopup } from "./confirmPopup.js";

/**
 * host keeps the credentials, the page only ever gets names and colors
 *
 * @typedef {object} Account
 * @property {string} username
 * @property {string} color
 */

/**
 * @typedef {object} LegacyAccount
 * @property {string} username
 * @property {string} password
 * @property {string} color
 */

const LEGACY_KEY = "accounts";
const DEFAULT_COLOR = "#35e0e8";
const STALE_SESSION = /different account/i;
// popup shows right after login or never
const WATCH_MS = 30000;
// sessionStorage, stops hop loops
const HOP_KEY = "kute_account_hop";
const HOP_QUIET_MS = 15000;

/**
 * @param {string} encoded
 * @return {string}
 */
function legacyDecode(encoded){
    const text = decodeURIComponent(encoded);
    const key = text.length;
    return text
        .split("")
        .map((char) => String.fromCharCode(char.charCodeAt(0) - key))
        .join("");
}

/**
 * @param {string} decoded
 * @return {string}
 */
function legacyEncode(decoded){
    const key = decoded.length;
    const encoded = decoded
        .split("")
        .map((char) => String.fromCharCode(char.charCodeAt(0) + key))
        .join("");
    return encodeURIComponent(encoded);
}

/**
 * @return {LegacyAccount[]}
 */
function legacyAccounts(){
    try {
        const list = JSON.parse(localStorage.getItem(LEGACY_KEY) || "[]");
        return Array.isArray(list) ? list : [];
    }
    catch {
        return [];
    }
}

/**
 * @param {string|undefined} color
 * @return {string}
 */
function safeColor(color){
    return typeof color === "string" && /^#[\da-f]{6}$/i.test(color) ? color : DEFAULT_COLOR;
}

/**
 * @param {string} color "#rrggbb"
 * @return {string}
 */
function readableOn(color){
    const value = Number.parseInt(color.slice(1), 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? "#111" : "#fff";
}

/**
 * @param {HTMLElement} avatar
 * @param {string} color
 * @param {string} username
 */
function paintAvatar(avatar, color, username){
    const background = safeColor(color);
    avatar.style.background = background;
    avatar.style.color = readableOn(background);
    avatar.textContent = username.trim().slice(0, 1) || "?";
}

class AccountManager {
    constructor(){
        /** @type {HTMLDivElement} */
        this.button = document.createElement("div");
        this.button.textContent = "Accounts";
        this.button.classList.add("button", "buttonB", "bigShadowT");
        this.button.style.cssText =
            "display: block; padding-top: 7px; padding-bottom: 22px; font-size: 25px!important; padding-bottom: 22px; margin-top: 7px; height: 21px; line-height: 35px; width: 162px; font-size:20px!important; margin-left: 3px;";

        /** @type {HTMLDivElement} */
        this.headerSeparator = document.createElement("div");
        this.headerSeparator.style.cssText = "width: 4px; height: 35px; margin: 0 6px; background: rgba(255, 255, 255, 0.12); flex-shrink: 0;";
        /** @type {HTMLDivElement} */
        this.headerItem = document.createElement("div");
        this.headerItem.style.cssText =
            "display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; color: #fff; font-weight: 700; font-size: 16px; white-space: nowrap;";
        this.headerItem.innerHTML = '<span class="material-icons" style="font-size: 20px;">switch_account</span><span>Accounts</span>';

        /** @type {MutationObserver} */
        this.headerObserver = new MutationObserver(() => {
            this.placeButton();
            this.trackAccount();
        });

        this.sessionAccount = localStorage.getItem("krunker_username") ?? "";
        this.watching = false;
        /** @type {(() => void)|null} */
        this.stopWatching = null;

        // shadow root so krunker's ids and css can't reach the menu
        /** @type {HTMLDivElement|null} */
        this.overlay = null;
        /** @type {ShadowRoot|null} */
        this.shadow = null;
        /** @type {AbortController|null} */
        this.menuController = null;
        /** remove confirm is up, escape belongs to it */
        this.asking = false;

        /** @type {Account[]} */
        this.accounts = [];
        /** old exe without the account commands, localStorage fallback */
        this.legacy = false;

        kute.settings.toggleAccountManager = (enabled) => this.toggle(enabled);

        this.toggle(true);
        this.load();
    }

    async load(){
        const legacy = legacyAccounts();
        let accounts = null;
        if (legacy.length > 0){
            const migrated = legacy
                .filter((account) => typeof account?.username === "string" && typeof account?.password === "string")
                .map((account) => ({ username: legacyDecode(account.username), password: legacyDecode(account.password), color: account.color }));
            accounts = await request(`accounts-migrate ${JSON.stringify(migrated)}`, "accounts", 5000);
            if (accounts !== null) localStorage.removeItem(LEGACY_KEY);
        }
        else {
            accounts = await request("accounts-list", "accounts");
        }
        if (accounts === null){
            this.legacy = true;
            this.accounts = legacy.map((account) => ({ username: legacyDecode(account.username), color: account.color }));
        }
        else {
            this.accounts = accounts;
        }
        this.renderAccounts();
    }

    /**
     * @param {string} command "add", "remove" or "login"
     * @param {object} payload
     */
    async send(command, payload){
        const accounts = await request(`accounts-${command} ${JSON.stringify(payload)}`, "accounts");
        if (accounts === null) return;
        this.accounts = accounts;
        this.renderAccounts();
    }

    /**
     * @param {MessageEvent} event
     */
    gameUpdateListener = (event) => {
        if (event.data === "game-updated"){
            setTimeout(() => {
                if (checkCompMode()){
                    window.chrome.webview.removeEventListener("message", this.gameUpdateListener);
                    this.button.style.cssText =
                        "display: block; padding: 14px 24px 22px; bottom: 0; right: 0; z-index: 9; font-size: 21px !important; position: absolute;";
                    getElement("#compBtnLst").append(this.button);
                }
            }, 2000);
        }
    };

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        if (enabled){
            window.chrome.webview.addEventListener("message", this.gameUpdateListener);
            this.button.addEventListener("click", this.openMenu);
            this.headerItem.addEventListener("click", this.openMenu);
            if (checkCompMode()){
                window.chrome.webview.removeEventListener("message", this.gameUpdateListener);
                this.button.style.cssText =
                    "display: block; padding: 14px 24px 22px; bottom: 0; right: 0; z-index: 9; font-size: 21px !important; position: absolute;";
                getElement("#compBtnLst").append(this.button);
            }
            else {
                this.placeButton();
                // header re-renders on login/logout and drops the button
                const header = document.querySelector("#playerHeaderEl");
                if (header) this.headerObserver.observe(header, { childList: true, subtree: true });
            }
        }
        else {
            window.chrome.webview.removeEventListener("message", this.gameUpdateListener);
            this.headerObserver.disconnect();
            this.button.removeEventListener("click", this.openMenu);
            this.headerItem.removeEventListener("click", this.openMenu);
            this.button.remove();
            this.headerSeparator.remove();
            this.headerItem.remove();
            this.closeMenu();
            this.stopWatching?.();
        }
    }

    // not the left bar, it runs under the logo
    placeButton(){
        const right = document.querySelector("#playerHeaderEl .headerBarRight");
        if (right){
            if (right.firstElementChild !== this.headerItem){
                // unstyled without krunker's svelte scope class
                const scope = [...(right.querySelector(".nav-item")?.classList ?? [])].find((name) => name.startsWith("svelte-")) ?? "";
                this.headerItem.style.cssText = "";
                this.headerItem.className = `nav-item ${scope}`;
                this.headerItem.innerHTML = `<span class="material-icons nav-mat-icon ${scope}">switch_account</span> <span class="nav-label ${scope}">Accounts</span>`;
                this.headerSeparator.className = "verticalSeparator";
                this.headerSeparator.style.cssText = "height: 35px;";
                right.prepend(this.headerItem, this.headerSeparator);
            }
            this.button.remove();
            return;
        }

        const signedIn = document.querySelector("#signedInHeaderBar");
        if (signedIn){
            if (!signedIn.contains(this.headerItem)) signedIn.append(this.headerSeparator, this.headerItem);
            return;
        }
        const signedOut = document.querySelector("#signedOutHeaderBar");
        if (signedOut && !signedOut.contains(this.button)) signedOut.append(this.button);
    }

    /**
     * only a switch within one page load goes stale, not a first login or logout
     */
    trackAccount(){
        const current = localStorage.getItem("krunker_username") ?? "";
        if (current === "" || current === this.sessionAccount) return;
        const switched = this.sessionAccount !== "";
        this.sessionAccount = current;
        if (switched) this.watchForStaleSession();
    }

    watchForStaleSession(){
        if (this.watching) return;
        this.watching = true;

        /**
         * textContent, innerText forces a layout
         *
         * @param {Node} node
         * @return {boolean}
         */
        const isPopup = (node) => STALE_SESSION.test(node.textContent ?? "");
        /** @type {{observer?: MutationObserver, timer: number}} */
        const watch = { timer: 0 };
        const stop = () => {
            clearTimeout(watch.timer);
            watch.observer?.disconnect();
            this.watching = false;
            this.stopWatching = null;
        };

        watch.observer = new MutationObserver((records) => {
            for (const record of records){
                // popup is either inserted or an existing element gets shown
                const hit = record.type === "childList"
                    ? [...record.addedNodes].some(isPopup)
                    : record.target !== document.body && record.target !== document.documentElement && isPopup(record.target);
                if (!hit) continue;
                stop();
                this.leaveStaleSession();
                return;
            }
        });
        watch.timer = setTimeout(stop, WATCH_MS);
        this.stopWatching = stop;

        // body wide, hence the time limit. popup has no stable container
        watch.observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributeFilter: ["style", "class"],
        });
    }

    /**
     * new lobby like F4 (?exclude=), a plain reload often hits "game is full"
     */
    leaveStaleSession(){
        const last = Number(sessionStorage.getItem(HOP_KEY) ?? 0);
        if (Date.now() - last < HOP_QUIET_MS) return;
        sessionStorage.setItem(HOP_KEY, String(Date.now()));

        // raw id like the host cuts it, re-encoding changes it
        const game = location.search.split("game=")[1]?.trim();
        const target = game ? `https://krunker.io/?exclude=${game}` : "https://krunker.io/";
        // krunker still writes the new session when the popup shows
        setTimeout(() => window.location.assign(target), 300);
    }

    openMenu = () => {
        if (this.overlay) return;
        this.buildMenu().catch((error) => console.error("[kute] accounts:", error));
    };

    /**
     * @return {Promise<void>}
     */
    async buildMenu(){
        const html = await import("../components/accountManager.html");
        if (this.overlay) return;

        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = html.default;
        this.overlay = overlay;
        this.shadow = shadow;

        const controller = new AbortController();
        this.menuController = controller;

        getElement("#accClose", shadow).onclick = () => this.closeMenu();
        getElement("#accAdd", shadow).onclick = () => this.showForm(true);
        getElement("#accCancel", shadow).onclick = () => this.showForm(false);
        getElement("#accSave", shadow).onclick = () => this.saveAccount();
        getElement("#accFormHint", shadow).textContent = this.legacy
            ? "Saved on this PC only"
            : "Saved encrypted on this PC, never sent anywhere";

        const username = getInput("#accUsername", shadow);
        const color = getInput("#accColor", shadow);
        username.oninput = () => this.updatePreview();
        color.oninput = () => this.updatePreview();
        for (const input of [username, getInput("#accPassword", shadow)]){
            input.onkeydown = (event) => {
                if (event.key === "Enter") this.saveAccount();
            };
        }
        // keep krunker's document hotkeys quiet while typing
        for (const type of ["keydown", "keyup", "keypress"]){
            shadow.addEventListener(type, (event) => event.stopPropagation());
        }

        overlay.addEventListener("mousedown", (event) => {
            if (event.target === overlay) this.closeMenu();
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape" || this.asking) return;
                event.stopPropagation();
                if (getElement("#accFormView", shadow).hidden) this.closeMenu();
                else this.showForm(false);
            },
            { signal: controller.signal, capture: true },
        );

        this.renderAccounts();
        this.resetForm();
        document.body.append(overlay);
    }

    closeMenu(){
        this.menuController?.abort();
        this.menuController = null;
        this.overlay?.remove();
        this.overlay = null;
        this.shadow = null;
    }

    /**
     * @param {boolean} show
     */
    showForm(show){
        if (!this.shadow) return;
        getElement("#accListView", this.shadow).hidden = show;
        getElement("#accFormView", this.shadow).hidden = !show;
        if (!show) return;
        this.resetForm();
        getInput("#accUsername", this.shadow).focus();
    }

    renderAccounts(){
        const { shadow } = this;
        if (!shadow) return;

        const list = getElement("#accList", shadow);
        list.textContent = "";
        for (const account of this.accounts){
            const row = document.createElement("div");
            row.className = "accRow";
            row.title = `Log in as ${account.username}`;
            // waitForElement rejects when the header never switches
            row.onclick = () => this.login(account).catch((error) => console.error("[kute] accounts:", error));

            const avatar = document.createElement("div");
            avatar.className = "accAvatar";
            paintAvatar(avatar, account.color, account.username);

            const name = document.createElement("div");
            name.className = "accName";
            name.textContent = account.username;

            const remove = document.createElement("div");
            remove.className = "accRemove";
            remove.textContent = "×";
            remove.title = "Remove";
            remove.onclick = (event) => {
                event.stopPropagation();
                this.removeAccount(account).catch((error) => console.error("[kute] accounts:", error));
            };

            row.append(avatar, name, remove);
            list.append(row);
        }

        const empty = this.accounts.length === 0;
        getElement("#accEmpty", shadow).hidden = !empty;
        getElement("#accListHint", shadow).hidden = empty;
    }

    updatePreview(){
        if (!this.shadow) return;
        const username = getInput("#accUsername", this.shadow).value;
        const color = getInput("#accColor", this.shadow).value;
        paintAvatar(getElement("#accPreviewAvatar", this.shadow), color, username);
        getElement("#accPreviewName", this.shadow).textContent = username.trim() || "Username";
    }

    resetForm(){
        if (!this.shadow) return;
        getInput("#accColor", this.shadow).value = `#${Math.floor(Math.random() * 16777215)
            .toString(16)
            .padStart(6, "0")}`;
        getInput("#accUsername", this.shadow).value = "";
        getInput("#accPassword", this.shadow).value = "";
        getElement("#accError", this.shadow).textContent = "";
        this.updatePreview();
    }

    saveAccount(){
        if (!this.shadow) return;
        const username = getInput("#accUsername", this.shadow).value.trim();
        const password = getInput("#accPassword", this.shadow).value;
        const color = getInput("#accColor", this.shadow).value;
        const error = getElement("#accError", this.shadow);

        if (username === ""){
            error.textContent = "Enter a username";
            return;
        }
        if (password === ""){
            error.textContent = "Enter a password";
            return;
        }
        if (this.accounts.some((account) => account.username === username)){
            error.textContent = `${username} is already saved`;
            return;
        }

        if (this.legacy){
            const list = legacyAccounts();
            list.push({ username: legacyEncode(username), password: legacyEncode(password), color });
            localStorage.setItem(LEGACY_KEY, JSON.stringify(list));
            this.accounts.push({ username, color });
            this.renderAccounts();
        }
        else {
            this.send("add", { username, password, color });
        }
        this.showForm(false);
    }

    /**
     * asks first, it's the only copy of the password
     *
     * @param {Account} account
     * @return {Promise<void>}
     */
    async removeAccount(account){
        this.asking = true;
        const confirmed = await confirmPopup({
            title: "Remove account",
            paragraphs: [`${account.username} gets removed from this list.`, "The Krunker account itself is not touched."],
            stay: "Keep",
            leave: "Remove",
        });
        this.asking = false;
        if (!confirmed) return;

        const index = this.accounts.findIndex((entry) => entry.username === account.username);
        if (index === -1) return;
        if (this.legacy){
            localStorage.setItem(
                LEGACY_KEY,
                JSON.stringify(legacyAccounts().filter((entry) => legacyDecode(entry.username) !== account.username)),
            );
            this.accounts.splice(index, 1);
            this.renderAccounts();
        }
        else {
            this.send("remove", { username: account.username });
        }
    }

    /**
     * @param {Account} account
     * @return {Promise<void>}
     */
    async login(account){
        this.closeMenu();
        // session is from the page load, logging in over it goes stale
        const wasSignedIn = document.querySelector("#signedInHeaderBar") !== null;
        if (wasSignedIn){
            window.logoutAcc();
            await waitForElement("#signedOutHeaderBar");
        }
        window.loginOrRegister();
        if (wasSignedIn) this.watchForStaleSession();

        queueMicrotask(() => {
            const authToggle = getElement(".auth-toggle-btn");
            if (authToggle.textContent?.includes("username")) authToggle.click();

            queueMicrotask(() => {
                if (this.legacy){
                    this.legacyLogin(account.username);
                    return;
                }
                // host fills the form over cdp
                this.send("login", { username: account.username });
            });
        });
    }

    /**
     * @param {string} username
     */
    legacyLogin(username){
        const stored = legacyAccounts().find((account) => legacyDecode(account.username) === username);
        if (!stored) return;
        const nameInput = getInput("#accName");
        const passInput = getInput("#accPass");
        nameInput.value = username;
        passInput.value = legacyDecode(stored.password);
        // krunker treats it as empty without an input event
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        passInput.dispatchEvent(new Event("input", { bubbles: true }));
        getElement(".io-button").click();
    }
}

export default new AccountManager();
