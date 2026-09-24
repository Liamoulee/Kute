import { kute } from "../client.js";

// own headshots only, found via the kill feed
class HsSound {
    constructor(){
        /** @type {(soundName: string, volume?: number, loop?: boolean) => any} */
        this.originalPlay = () => {};
        /** @type {MutationObserver} */
        this.observer = new MutationObserver((mutations) => this.parseChat(mutations));
        kute.settings.toggleHsSound = (enabled) => this.toggle(enabled);

        this.setupSoundHook();
    }

    setupSoundHook(){
        if (window.SOUND?.play){
            this.originalPlay = window.SOUND.play;
            this.toggle(true);
        }
        else setTimeout(() => this.setupSoundHook(), 100);
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        if (enabled){
            const chatList = document.querySelector("#chatList");
            if (chatList){
                this.observer.observe(chatList, {
                    childList: true,
                });
            }
            const self = this;
            /**
             * drops the game's own headshot sound (no volume arg)
             *
             * @param {string} soundName
             * @param {number} [volume]
             * @param {boolean} [loop]
             * @return {any}
             */
            window.SOUND.play = function(soundName, volume, loop){
                if (soundName === "headshot_0" && volume === undefined) return undefined;
                return self.originalPlay.call(window.SOUND, soundName, volume, loop);
            };
        }
        else {
            window.SOUND.play = this.originalPlay;
            this.observer.disconnect();
        }
    }

    /**
     * @param {MutationRecord[]} mutations
     */
    parseChat(mutations){
        for (const mutation of mutations){
            if (mutation.type !== "childList") continue;

            for (const newNode of mutation.addedNodes){
                if (!(newNode instanceof HTMLElement) || newNode.tagName !== "DIV") continue;

                const messageSpan = newNode.querySelector("span.chatMsg");
                if (!messageSpan) continue;

                const coloredSpans = /** @type {NodeListOf<HTMLElement>} */ (
                    messageSpan.querySelectorAll("span[style*='color:#'], span[style*='color: rgb']")
                );
                if (coloredSpans.length <= 0) continue;
                const firstColoredSpan = coloredSpans[0];
                const spanColor = firstColoredSpan.style.color.trim().toLowerCase();
                const spanText = firstColoredSpan.textContent.trim();

                if (spanColor === "rgb(255, 255, 255)" && spanText === "You" && messageSpan.querySelector("img")){
                    window.SOUND.play("headshot_0", 1, false);
                }
            }
        }
    }
}

export default new HsSound();
