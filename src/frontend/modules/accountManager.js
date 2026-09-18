import { kute } from "../client.js";
import { getElement, getInput, checkCompMode, waitForElement, request } from "../utils.js";

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

        /** @type {HTMLDivElement} */
        this.container = document.createElement("div");
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
        if (document.contains(this.container)) this.updateAccounts();
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
        if (document.contains(this.container)) this.updateAccounts();
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
            this.button.addEventListener("click", this.createMenu);
            this.headerItem.addEventListener("click", this.createMenu);
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
            this.button.removeEventListener("click", this.createMenu);
            this.headerItem.removeEventListener("click", this.createMenu);
            this.button.remove();
            this.headerSeparator.remove();
            this.headerItem.remove();
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
     * Dispatches clicks inside the account menu.
     *
     * @param {MouseEvent} event
     */
    handleMenuClick = (event) => {
        const clickedElement = /** @type {HTMLElement} */ (event.target);
        if (clickedElement.classList.contains("accountHolder")){
            this.handleAccountSelection(clickedElement);
        }
        else {
            switch (clickedElement.id){
                case "newAccountButton":
                    this.switchTabs();
                    break;
                case "createAccountButton":
                    this.createNewAccount();
                    break;
                case "accountMenu":
                case "windowHolder":
                case "accountContainer":
                    this.removeWindow();
                    break;
                default:
                    break;
            }
        }
    };

    /**
     * Stores the credentials from the creator form, unless empty or already known.
     */
    createNewAccount(){
        const username = getInput("#username").value;
        const password = getInput("#password").value;
        const color = getInput("#color-picker").value;

        if (username.replace(/\s/, "") === "" || password.replace(/\s/, "") === ""){
            this.switchTabs();
            return;
        }
        if (this.accounts.some((account) => account.username === username)) return;

        if (this.legacy){
            const list = legacyAccounts();
            list.push({ username: legacyEncode(username), password: legacyEncode(password), color });
            localStorage.setItem(LEGACY_KEY, JSON.stringify(list));
            this.accounts.push({ username, color });
            this.updateAccounts();
        }
        else {
            this.send("add", { username, password, color });
        }
        this.resetForm();
        this.switchTabs();
    }

    /**
     * Opens Krunker's login form in username mode, then has the host fill and submit it. Logs the current
     * account out first.
     *
     * @param {HTMLElement} element The clicked account entry
     * @return {Promise<void>}
     */
    async handleAccountSelection(element){
        const account = this.accounts.find((acc) => acc.username === element.textContent);
        if (!account) return;

        this.removeWindow();
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

    /**
     * Clears the creator form and picks a random color.
     */
    resetForm(){
        getInput("#color-picker").value = `#${Math.floor(Math.random() * 16777215)
            .toString(16)
            .padStart(6, "0")}`;
        getInput("#username").value = "";
        getInput("#password").value = "";
    }

    /**
     * Toggles between the account list and the creator form.
     */
    switchTabs(){
        getElement("#accountContainerTab").classList.toggle("hidden");
        getElement("#accountCreatorTab").classList.toggle("hidden");
    }

    /**
     * Re-renders the account list from {@link AccountManager#accounts}.
     */
    updateAccounts(){
        const accountContainer = getElement("#accountContainer");
        while (accountContainer.children.length > 0){
            accountContainer.removeChild(accountContainer.children[0]);
        }

        for (const account of this.accounts){
            const accountHolder = document.createElement("div");
            accountHolder.classList.add("accountHolder");
            accountHolder.style.color = account.color;
            accountHolder.textContent = account.username;
            accountContainer.append(accountHolder);
        }
    }

    /**
     * Closes the account menu and detaches its listeners.
     */
    removeWindow(){
        this.container.removeEventListener("contextmenu", this.handleMenuClick);
        document.removeEventListener("click", this.handleMenuClick);
        this.container.remove();
    }

    /**
     * Opens the account menu.
     */
    createMenu = () => {
        import("../components/accountManager.html").then((html) => {
            this.container.innerHTML = html.default;
            document.body.append(this.container);
            this.updateAccounts();
            this.container.addEventListener("contextmenu", this.removeAccount);
            document.addEventListener("click", this.handleMenuClick);
            getInput("#color-picker").value = `#${Math.floor(Math.random() * 16777215)
                .toString(16)
                .padStart(6, "0")}`;
        });
    };

    /**
     * Deletes the right-clicked account.
     *
     * @param {MouseEvent} event
     */
    removeAccount = (event) => {
        event.preventDefault();
        const clickedElement = /** @type {HTMLElement} */ (event.target);
        if (clickedElement.classList.contains("accountHolder")){
            const username = clickedElement.textContent ?? "";
            const index = this.accounts.findIndex((account) => account.username === username);
            if (index === -1) return;
            if (this.legacy){
                localStorage.setItem(LEGACY_KEY, JSON.stringify(legacyAccounts().filter((account) => legacyDecode(account.username) !== username)));
                this.accounts.splice(index, 1);
                this.updateAccounts();
            }
            else {
                this.send("remove", { username });
            }
        }
    };
}

export default new AccountManager();
