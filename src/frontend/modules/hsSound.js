/**
 * Plays the headshot sound only on the player's own headshots, detected through the kill feed in chat.
 */
class HsSound {
    constructor(){
        /** @type {(soundName: string, volume?: number, loop?: boolean) => any} */
        this.originalPlay = () => {};
        /** @type {MutationObserver} */
        this.observer = new MutationObserver((mutations) => this.parseChat(mutations));
        window.kute.settings.toggleHsSound = (enabled) => this.toggle(enabled);

        this.setupSoundHook();
    }

    /**
     * Waits for Krunker's SOUND object to exist, then installs the hook.
     */
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
             * Drops the game's own headshot sound (called without a volume) and forwards everything else.
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
     * Plays the headshot sound for new chat entries that show the player scoring a headshot.
     *
     * @param {MutationRecord[]} mutations
     */
    parseChat(mutations){
        for (const mutation of mutations){
            if (mutation.type !== "childList") continue;

            for (const newNode of mutation.addedNodes){
                if (newNode.nodeType !== 1 || newNode.tagName !== "DIV") continue;

                const messageSpan = newNode.querySelector("span.chatMsg");
                if (!messageSpan) continue;

                const coloredSpans = messageSpan.querySelectorAll("span[style*='color:#'], span[style*='color: rgb']");
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
