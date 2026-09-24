import { kute } from "../client.js";
import { getElement, getInput } from "../utils.js";

class BetterChat {
    constructor(){
        /** @type {Set<string>} */
        this.teamModes = new Set([
            "Team Deathmatch",
            "Hardpoint",
            "Capture the Flag",
            "Hide & Seek",
            "Infected",
            "Last Man Standing",
            "Simon Says",
            "Prop Hunt",
            "Boss Hunt",
            "Deposit",
            "Stalker",
            "Kill Confirmed",
            "Defuse",
            "Traitor",
            "Blitz",
            "Domination",
            "Squad Deathmatch",
            "Team Defender",
        ]);
        /** @type {HTMLStyleElement} */
        this.styles = document.createElement("style");
        import("../components/betterChat.css").then((css) => {
            this.styles.innerHTML = css.default;
        });

        kute.settings.toggleBetterChat = (enabled) => this.toggle(enabled);

        /** @type {HTMLElement} */
        this.chatHolder = getElement("#chatHolder");
        /** @type {HTMLElement} */
        this.chatList = getElement("#chatList");
        /** @type {HTMLInputElement} */
        this.chatInput = getInput("#chatInput");
        /** @type {HTMLElement} */
        this.chatSwitch = getElement("#chatSwitch");
        /** @type {HTMLDivElement} */
        this.channelT = document.createElement("div");
        /** @type {HTMLDivElement} */
        this.channelA = document.createElement("div");
        this.channelT.style.cssText = "float: left; display: inline-block; margin-right: 5px; color: #9eeb56;";
        this.channelT.textContent = "[T]";
        this.channelA.style.cssText = "float: left; display: inline-block; margin-right: 5px; color: #eb5656;";
        this.channelA.textContent = "[M]";

        /** @type {MutationObserver} */
        this.observer = new MutationObserver((mutations) => this.parseMessages(mutations));
        this.toggle(true);
    }

    /**
     * @param {KeyboardEvent} event
     */
    switchChat = (event) => {
        if (event.key !== "Tab") return;
        window.switchChat(this.chatSwitch);
        event.preventDefault();
    };

    clearChat = () => {
        this.chatInput.value = "";
        this.chatInput.blur();
    };

    /**
     * @param {MutationRecord[]} mutations
     */
    parseMessages(mutations){
        let tagged = false;
        for (const mutation of mutations){
            for (const node of mutation.addedNodes){
                // text nodes have no querySelector, a throw kills the whole batch
                if (!(node instanceof HTMLElement)) continue;
                const chatItem = node.querySelector(".chatItem");
                if (!chatItem) continue;
                const chatMsg = chatItem.querySelector(".chatMsg");
                if (!chatMsg) continue;
                if (chatMsg.textContent.includes("Text & Voice Chat")){
                    node.remove();
                    continue;
                }
                // cheap check first, kill feed lines have no tab
                const { tab } = node.dataset;
                if (!tab || !chatItem.textContent.includes("\u200E:") || !this.teamModes.has(window.getGameActivity().mode)) continue;
                if (tab === "0") chatMsg.insertBefore(this.channelA.cloneNode(true), chatMsg.firstChild);
                else if (tab === "1") chatMsg.insertBefore(this.channelT.cloneNode(true), chatMsg.firstChild);
                tagged = true;
            }
        }
        // once per batch, scrollTop forces layout. no scrollHeight read, 1e9 gets clamped
        if (tagged) this.chatList.scrollTop = 1e9;
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        if (enabled){
            document.head.append(this.styles);
            this.chatInput.addEventListener("keydown", this.switchChat, { capture: true });
            this.chatInput.addEventListener("blur", this.clearChat);
            this.observer.observe(this.chatList, { childList: true });
        }
        else {
            this.styles.remove();
            this.chatInput.removeEventListener("keydown", this.switchChat, { capture: true });
            this.chatInput.removeEventListener("blur", this.clearChat);
            this.observer.disconnect();
        }
    }
}

export default new BetterChat();
