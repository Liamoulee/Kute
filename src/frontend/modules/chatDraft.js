// krunker's conversation effect clears the draft on open, but it also reads the chat history, so every incoming message reruns it
const SEND_WINDOW_MS = 250;

class ChatDraft {
    /** @type {WeakSet<HTMLTextAreaElement>} */
    tracked = new WeakSet();
    /** @type {{ input: HTMLTextAreaElement, friend: string, text: string, start: number, end: number } | null} */
    draft = null;
    /** @type {MutationObserver | null} */
    observer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    pending = null;
    sentAt = 0;

    constructor(){
        // focusin instead of a document keydown listener, that one would run on every key in a match
        document.addEventListener("focusin", (event) => {
            const input = event.target;
            if (input instanceof HTMLTextAreaElement && input.classList.contains("conversation-input")) this.track(input);
        });
    }

    /**
     * @param {HTMLTextAreaElement} input
     * @return {string}
     */
    friendOf(input){
        return input.closest(".conversation-root")?.querySelector(".conversation-header-name")?.textContent ?? "";
    }

    /**
     * @param {HTMLTextAreaElement} input
     */
    track(input){
        if (this.tracked.has(input)) return;
        this.tracked.add(input);
        input.addEventListener("input", () => this.save(input));
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) this.sentAt = performance.now();
        });
        input.closest(".conversation-compose")?.querySelector(".conversation-send-button")?.addEventListener("click", () => {
            this.sentAt = performance.now();
        });
        if (input.value) this.save(input);
    }

    /**
     * @param {HTMLTextAreaElement} input
     */
    save(input){
        if (!input.value){
            this.stop();
            return;
        }
        this.draft = { input, friend: this.friendOf(input), text: input.value, start: input.selectionStart, end: input.selectionEnd };
        if (this.observer) return;
        const root = input.closest(".conversation-root");
        if (!root) return;
        this.observer = new MutationObserver(() => this.schedule());
        this.observer.observe(root, { childList: true, subtree: true, characterData: true });
    }

    // svelte sets the value in a later microtask than the dom update that wakes the observer
    schedule(){
        if (this.pending === null) this.pending = setTimeout(() => this.check(), 0);
    }

    check(){
        this.pending = null;
        const { draft } = this;
        if (!draft) return;
        const { input } = draft;
        if (!input.isConnected || this.friendOf(input) !== draft.friend){
            this.stop();
            return;
        }
        if (input.value){
            // emoji picks change the value without an input event
            this.save(input);
            return;
        }
        if (performance.now() - this.sentAt < SEND_WINDOW_MS){
            this.stop();
            return;
        }
        input.value = draft.text;
        if (document.activeElement === input) input.setSelectionRange(draft.start, draft.end);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    stop(){
        this.draft = null;
        this.observer?.disconnect();
        this.observer = null;
    }
}

export default new ChatDraft();
