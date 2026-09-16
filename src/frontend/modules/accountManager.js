import { kute } from "../client.js";
import { getElement, getInput, checkCompMode } from "../utils.js";

/**
 * Stored account credentials. Username and password are obfuscated with {@link AccountManager#encode}.
 *
 * @typedef {object} Account
 * @property {string} username
 * @property {string} password
 * @property {string} color
 */

/**
 * Adds an "Accounts" button that lets the user save and switch between login credentials.
 */
class AccountManager {
    constructor(){
        /** @type {HTMLDivElement} */
        this.button = document.createElement("div");
        this.button.textContent = "Accounts";
        this.button.classList.add("button", "buttonB", "bigShadowT");
        this.button.style.cssText =
            "display: block; padding-top: 7px; padding-bottom: 22px; font-size: 25px!important; padding-bottom: 22px; margin-top: 7px; height: 21px; line-height: 35px; width: 162px; font-size:20px!important; margin-left: 3px;";

        /** @type {HTMLDivElement} */
        this.container = document.createElement("div");
        /** @type {Account[]} */
        this.accounts = JSON.parse(localStorage.getItem("accounts") || "[]");

        kute.settings.toggleAccountManager = (enabled) => this.toggle(enabled);

        this.toggle(true);
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
            document.querySelector("#signedOutHeaderBar")?.append(this.button);
            this.button.addEventListener("click", this.createMenu);
            if (checkCompMode()){
                window.chrome.webview.removeEventListener("message", this.gameUpdateListener);
                this.button.style.cssText =
                    "display: block; padding: 14px 24px 22px; bottom: 0; right: 0; z-index: 9; font-size: 21px !important; position: absolute;";
                getElement("#compBtnLst").append(this.button);
            }
        }
        else {
            window.chrome.webview.removeEventListener("message", this.gameUpdateListener);
            this.button.removeEventListener("click", this.createMenu);
            this.button.remove();
        }
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
     * Obfuscates a string by shifting every char code by the string length.
     *
     * @param {string} decoded
     * @return {string}
     */
    encode(decoded){
        const key = decoded.length;
        const encoded = decoded
            .split("")
            .map((char) => String.fromCharCode(char.charCodeAt(0) + key))
            .join("");
        return encodeURIComponent(encoded);
    }

    /**
     * Stores the credentials from the creator form, unless empty or already known.
     */
    createNewAccount(){
        let username = getInput("#username").value;
        let password = getInput("#password").value;
        const color = getInput("#color-picker").value;

        if (username.replace(/\s/, "") === "" || password.replace(/\s/, "") === ""){
            this.switchTabs();
            return;
        }
        if (this.accounts.some((account) => this.decode(account.username) === username)) return;

        username = this.encode(username);
        password = this.encode(password);

        this.accounts.push({ username, password, color });
        localStorage.setItem("accounts", JSON.stringify(this.accounts));
        this.resetForm();
        this.updateAccounts();
        this.switchTabs();
    }

    /**
     * Reverses {@link AccountManager#encode}.
     *
     * @param {string} encoded
     * @return {string}
     */
    decode(encoded){
        const username = decodeURIComponent(encoded);
        const key = username.length;
        return username
            .split("")
            .map((char) => String.fromCharCode(char.charCodeAt(0) - key))
            .join("");
    }

    /**
     * Fills Krunker's login form with the selected account and submits it.
     *
     * @param {HTMLElement} element The clicked account entry
     */
    handleAccountSelection(element){
        const account = this.accounts.find((acc) => this.decode(acc.username) === element.textContent);
        if (!account) return;

        this.removeWindow();
        window.loginOrRegister();

        queueMicrotask(() => {
            const authToggle = getElement(".auth-toggle-btn");
            if (authToggle.textContent?.includes("username")) authToggle.click();

            queueMicrotask(() => {
                const nameInput = getInput("#accName");
                const passInput = getInput("#accPass");
                nameInput.value = this.decode(account.username);
                passInput.value = this.decode(account.password);
                // send input otherwise it thinks its empty
                nameInput.dispatchEvent(new Event("input", { bubbles: true }));
                passInput.dispatchEvent(new Event("input", { bubbles: true }));
                getElement(".io-button").click();
            });
        });
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
            accountHolder.textContent = this.decode(account.username);
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
            const index = this.accounts.findIndex((account) => this.decode(account.username) === clickedElement.textContent);
            if (index > -1){
                this.accounts.splice(index, 1);
                localStorage.setItem("accounts", JSON.stringify(this.accounts));
                this.updateAccounts();
            }
        }
    };
}

export default new AccountManager();
