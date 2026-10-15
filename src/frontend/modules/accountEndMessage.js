import { kute } from "../client.js";

const SETTING_KEY = "kro_setngss_endMessage";
const FIELD_ID = "slid_endMessage";
// holds krunker's signed in or signed out bar, a login or logout swaps them
const HEADER_ID = "playerHeaderEl";
const SAVE_DELAY_MS = 500;

/**
 * krunker's header shows "signed out" for seconds after a load, so until it flips nobody is confirmed
 *
 * @return {string|null}
 */
function confirmedAccount(){
    if (!document.getElementById("signedInHeaderBar")) return null;
    try {
        return localStorage.getItem("krunker_username") || null;
    }
    catch {
        return null;
    }
}

/**
 * @return {string}
 */
function storedMessage(){
    try {
        return localStorage.getItem(SETTING_KEY) ?? "";
    }
    catch {
        return "";
    }
}

/**
 * Krunker's Match End Message per account. An account without one, or one not confirmed yet, sends nothing,
 * so an alt never sends the main's message.
 */
class AccountEndMessage {
    constructor(){
        /** @type {string|null|undefined} account whose message is in the game setting, undefined before the first check */
        this.account = undefined;
        this.header = new MutationObserver(() => this.check());
        this.saveTimer = 0;
        /** @type {string|null} */
        this.editedFor = null;

        /** @param {Event} event */
        this.onInput = (event) => {
            if (!(event.target instanceof HTMLInputElement) || event.target.id !== FIELD_ID || !this.account) return;
            // capture phase, krunker's oninput stores the value after this
            this.editedFor = this.account;
            clearTimeout(this.saveTimer);
            this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
        };

        kute.settings.toggleAccountEndMessage = (enabled) => this.toggle(enabled, true);
        this.toggle(!!kute.settings.data.accountEndMessage, false);
    }

    /**
     * @return {Record<string, string>}
     */
    get messages(){
        return { ...kute.settings.data.endMessages };
    }

    /**
     * @param {Record<string, string>} messages
     */
    save(messages){
        kute.settings.data.endMessages = messages;
        window.chrome.webview.postMessage(`set-config-json endMessages ${JSON.stringify(messages)}`);
    }

    /**
     * @param {string} account
     * @param {string} message
     */
    remember(account, message){
        const { messages } = this;
        if ((messages[account] ?? "") === message) return;
        if (message) messages[account] = message;
        else delete messages[account];
        this.save(messages);
    }

    flush(){
        clearTimeout(this.saveTimer);
        if (this.editedFor) this.remember(this.editedFor, storedMessage());
        this.editedFor = null;
    }

    check(){
        const account = confirmedAccount();
        if (account === this.account) return;
        // an edit made right before a switch belongs to the old account
        this.flush();
        this.account = account;
        const message = account ? this.messages[account] ?? "" : "";
        if (storedMessage() !== message) window.setSetting("endMessage", message);
    }

    /**
     * @param {boolean} enabled
     * @param {boolean} byPlayer
     */
    toggle(enabled, byPlayer){
        this.header.disconnect();
        document.removeEventListener("input", this.onInput, true);
        if (!enabled){
            this.flush();
            this.account = undefined;
            return;
        }

        // the message set right now stays with the account logged in, the others start empty
        const account = confirmedAccount();
        if (byPlayer && account){
            const message = storedMessage();
            this.remember(account, message);
            kute.showNotification(
                message ? `Kept "${message}" for ${account}. Other accounts send nothing until you give them one` : `End messages are now per account, ${account} has none`,
                false,
                6,
            );
        }

        document.addEventListener("input", this.onInput, true);
        const header = document.getElementById(HEADER_ID);
        if (header) this.header.observe(header, { childList: true });
        // without the header nobody gets confirmed and the message stays empty
        else console.error("[kute] end message: no account header");
        this.check();
    }
}

export default new AccountEndMessage();
