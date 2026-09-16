/**
 * Chat improvements: tab to switch channel, clear on blur, channel tags and chat notice removal.
 */
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

        window.kute.settings.toggleBetterChat = (enabled) => this.toggle(enabled);

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
     * Switches the chat channel on Tab.
     *
     * @param {KeyboardEvent} event
     */
    switchChat = (event) => {
        if (event.key !== "Tab") return;
        window.switchChat(this.chatSwitch);
        event.preventDefault();
    };

    /**
     * Clears and unfocuses the chat input.
     */
    clearChat = () => {
        this.chatInput.value = "";
        this.chatInput.blur();
    };

    /**
     * Tags new team-mode messages with their channel and drops the "Text & Voice Chat" notice.
     *
     * @param {MutationRecord[]} mutations
     */
    parseMessages(mutations){
        for (const mutation of mutations){
            for (const node of mutation.addedNodes){
                // text nodes have no querySelector, and a throw here aborts the whole mutation batch
                if (!(node instanceof HTMLElement)) continue;
                const chatItem = node.querySelector(".chatItem");
                if (!chatItem) continue;
                const chatMsg = chatItem.querySelector(".chatMsg");
                if (!chatMsg) continue;
                if (chatMsg.textContent.includes("Text & Voice Chat")){
                    node.remove();
                    continue;
                }
                if (
                    !chatItem.textContent.includes("\u200E:") ||
                    !this.teamModes.has(window.getGameActivity().mode) ||
                    !node.dataset.tab
                ){
                    continue;
                }
                if (node.dataset.tab === "0"){
                    const clone = this.channelA.cloneNode(true);
                    chatMsg.insertBefore(clone, chatMsg.firstChild);
                }
                if (node.dataset.tab === "1"){
                    const clone = this.channelT.cloneNode(true);
                    chatMsg.insertBefore(clone, chatMsg.firstChild);
                }
                this.chatList.scrollTop = this.chatList.scrollHeight;
            }
        }
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
