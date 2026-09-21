import { kute } from "../client.js";
import { getElement, getInput, checkCompMode, waitForElement, request } from "../utils.js";
import { confirmPopup } from "./confirmPopup.js";

/**
 * An entry as the page knows it: the host keeps the credentials (DPAPI encrypted in Documents\kute\accounts.json)
 * and only ever sends names and colors. A login is filled into Krunker's form by the host over CDP, so no
 * password crosses the bridge, which every script on the page could listen to.
 *
 * @typedef {object} Account
 * @property {string} username
 * @property {string} color
 */

/**
 * What the bundle stored before the host took over: obfuscated with {@link legacyDecode}'s inverse in localStorage.
 *
 * @typedef {object} LegacyAccount
 * @property {string} username
 * @property {string} password
 * @property {string} color
 */

const LEGACY_KEY = "accounts";
const DEFAULT_COLOR = "#35e0e8";

/**
 * Reverses the old obfuscation (every char code shifted by the string length, then URL encoded).
 *
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
 * The old obfuscation, only for an exe that does not know the account commands yet.
 *
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
 * The stored color, or the client's cyan when an old entry carries something else.
 *
 * @param {string|undefined} color
 * @return {string}
 */
function safeColor(color){
    return typeof color === "string" && /^#[\da-f]{6}$/i.test(color) ? color : DEFAULT_COLOR;
}

/**
 * Black or white, whichever stays readable on the picked color.
 *
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
 * The round color chip in front of a name, Krunker has no avatars to show.
 *
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

/**
 * Adds an "Accounts" button that lets the user save and switch between login credentials.
 * The button lives in the signed-out header, the signed-in header or the comp host UI, whichever is shown.
 */
class AccountManager {
    constructor(){
        /** @type {HTMLDivElement} */
        this.button = document.createElement("div");
        this.button.textContent = "Accounts";
        this.button.classList.add("button", "buttonB", "bigShadowT");
        this.button.style.cssText =
            "display: block; padding-top: 7px; padding-bottom: 22px; font-size: 25px!important; padding-bottom: 22px; margin-top: 7px; height: 21px; line-height: 35px; width: 162px; font-size:20px!important; margin-left: 3px;";

        // signed-in header entry, styled like krunker's own .ph-item entries
        /** @type {HTMLDivElement} */
        this.headerSeparator = document.createElement("div");
        this.headerSeparator.style.cssText = "width: 4px; height: 35px; margin: 0 6px; background: rgba(255, 255, 255, 0.12); flex-shrink: 0;";
        /** @type {HTMLDivElement} */
        this.headerItem = document.createElement("div");
        this.headerItem.style.cssText =
            "display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; color: #fff; font-weight: 700; font-size: 16px; white-space: nowrap;";
        this.headerItem.innerHTML = '<span class="material-icons" style="font-size: 20px;">switch_account</span><span>Accounts</span>';

        /** @type {MutationObserver} */
        this.headerObserver = new MutationObserver(() => this.placeButton());

        /** The open menu, or null. Its markup lives in a shadow root so the page's ids and css cannot reach it. */
        /** @type {HTMLDivElement|null} */
        this.overlay = null;
        /** @type {ShadowRoot|null} */
        this.shadow = null;
        /** @type {AbortController|null} */
        this.menuController = null;
        /** true while the remove question is up, so escape answers that one and not the menu */
        this.asking = false;

        /** @type {Account[]} */
        this.accounts = [];
        /** true once the host turned out to be an older exe without the account commands: localStorage as before */
        this.legacy = false;

        kute.settings.toggleAccountManager = (enabled) => this.toggle(enabled);

        this.toggle(true);
        this.load();
    }

    /**
     * Gets the list from the host. The first time, the entries the bundle used to keep in localStorage go to the
     * host and are deleted here once it confirms. An exe without the commands keeps the old localStorage way.
     */
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
     * Sends an account command and takes the list the host answers with.
     *
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
     * Moves the button into the comp host UI once a comp match is detected.
     *
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
                // the header is re-rendered on login and logout, which drops the button
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
        }
    }

    /**
     * Puts the entry at the start of the right header bar (the left one runs under the Krunker logo).
     * Falls back to the signed-in or signed-out bar when the right one is not rendered.
     */
    placeButton(){
        const right = document.querySelector("#playerHeaderEl .headerBarRight");
        if (right){
            if (right.firstElementChild !== this.headerItem){
                // krunker's own entries carry a svelte scope class, without it the entry is unstyled
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
     * Opens the account menu, the same overlay every other Kute popup uses.
     */
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
        // krunker binds its hotkeys on the document, typing a name must not trigger them
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
                // the form is a step inside the menu, escape goes back to the list first
                if (getElement("#accFormView", shadow).hidden) this.closeMenu();
                else this.showForm(false);
            },
            { signal: controller.signal, capture: true },
        );

        this.renderAccounts();
        this.resetForm();
        document.body.append(overlay);
    }

    /**
     * Closes the account menu and detaches its listeners.
     */
    closeMenu(){
        this.menuController?.abort();
        this.menuController = null;
        this.overlay?.remove();
        this.overlay = null;
        this.shadow = null;
    }

    /**
     * Switches between the list and the creator form.
     *
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

    /**
     * Re-renders the account list from {@link AccountManager#accounts}. Does nothing while the menu is closed.
     */
    renderAccounts(){
        const { shadow } = this;
        if (!shadow) return;

        const list = getElement("#accList", shadow);
        list.textContent = "";
        for (const account of this.accounts){
            const row = document.createElement("div");
            row.className = "accRow";
            row.title = `Log in as ${account.username}`;
            row.onclick = () => this.login(account);

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

    /**
     * Mirrors the form into the entry the list will show.
     */
    updatePreview(){
        if (!this.shadow) return;
        const username = getInput("#accUsername", this.shadow).value;
        const color = getInput("#accColor", this.shadow).value;
        paintAvatar(getElement("#accPreviewAvatar", this.shadow), color, username);
        getElement("#accPreviewName", this.shadow).textContent = username.trim() || "Username";
    }

    /**
     * Clears the creator form and picks a random color.
     */
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

    /**
     * Stores the credentials from the creator form, unless something is missing or already known.
     */
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
     * Asks first, the entry is the only copy of that password.
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
     * Opens Krunker's login form in username mode, then has the host fill and submit it. Logs the current
     * account out first.
     *
     * @param {Account} account
     * @return {Promise<void>}
     */
    async login(account){
        this.closeMenu();
        if (document.querySelector("#signedInHeaderBar")){
            window.logoutAcc();
            await waitForElement("#signedOutHeaderBar");
        }
        window.loginOrRegister();

        queueMicrotask(() => {
            const authToggle = getElement(".auth-toggle-btn");
            if (authToggle.textContent?.includes("username")) authToggle.click();

            queueMicrotask(() => {
                if (this.legacy){
                    this.legacyLogin(account.username);
                    return;
                }
                // the form exists now, the host fills it over CDP
                this.send("login", { username: account.username });
            });
        });
    }

    /**
     * The old way, for an exe without the account commands: the password from localStorage into the form.
     *
     * @param {string} username
     */
    legacyLogin(username){
        const stored = legacyAccounts().find((account) => legacyDecode(account.username) === username);
        if (!stored) return;
        const nameInput = getInput("#accName");
        const passInput = getInput("#accPass");
        nameInput.value = username;
        passInput.value = legacyDecode(stored.password);
        // send input otherwise it thinks its empty
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        passInput.dispatchEvent(new Event("input", { bubbles: true }));
        getElement(".io-button").click();
    }
}

export default new AccountManager();
