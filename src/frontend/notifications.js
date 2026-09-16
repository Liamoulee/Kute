/**
 * In-page toast notification. Optionally waits for a y/n keypress and resolves a promise with the answer.
 */
class KuteNotification {
    /**
     * @param {string} message
     * @param {boolean} reqUserInput
     * @param {number} duration Seconds until the notification hides itself
     */
    constructor(message, reqUserInput, duration){
        /** @type {string} */
        this.message = message;
        /** @type {boolean} */
        this.reqUserInput = reqUserInput;
        /** @type {number} */
        this.duration = duration;
        if (reqUserInput){
            /** @type {Promise<boolean>} */
            this.promise = new Promise((resolve) => {
                /** @type {(value: boolean) => void} */
                this.resolvePromise = resolve;
            });
        }
        this.show();
    }

    /**
     * Builds the notification DOM from the html component and appends it to the body.
     *
     * @return {Promise<void>}
     */
    async createNotificationElement(){
        /** @type {HTMLDivElement} */
        this.notificationEl = document.createElement("div");
        this.notificationEl.id = "notification";
        const notificationHtml = await import("./components/notification.html");
        this.notificationEl.innerHTML = notificationHtml.default;

        getElement("#notification-content", this.notificationEl).textContent = this.message;
        getElement("#notification-timer", this.notificationEl).textContent = String(this.duration);
        if (this.reqUserInput) getElement("#notification-actions", this.notificationEl).style.display = "block";

        document.body.append(this.notificationEl);
    }

    /**
     * Counts the duration down once per second and hides the notification when it reaches zero.
     */
    startTimer(){
        /** @type {number} */
        this.countdown = setInterval(() => {
            this.duration--;
            getElement("#notification-timer", this.notificationEl).textContent = String(this.duration);
            if (this.duration <= 0){
                clearInterval(this.countdown);
                if (this.resolvePromise) this.resolvePromise(false);
                this.hide();
            }
        }, 1000);
    }

    /**
     * Stops the timer, detaches the key listener and slides the notification out.
     */
    hide(){
        clearInterval(this.countdown);
        if (this.reqUserInput) document.removeEventListener("keydown", this.handlePromise);
        this.notificationEl.classList.add("slide-out");
        setTimeout(() => this.notificationEl.remove(), 2000);
    }

    /**
     * Creates the element, slides it in, starts the timer and, if requested, listens for a y/n answer.
     */
    show(){
        this.createNotificationElement();
        setTimeout(() => this.notificationEl.classList.add("slide-in"), 10);
        this.startTimer();

        if (this.reqUserInput){
            /** @type {(event: KeyboardEvent) => void} */
            this.handlePromise = (event) => {
                if (event.key === "y" || event.key === "n"){
                    const action = event.key === "y";

                    getElement(`#${event.key}`, this.notificationEl).classList.add("bounce");

                    this.resolvePromise(action);
                    this.hide();
                }
            };
            document.addEventListener("keydown", this.handlePromise);
        }
    }
}

/**
 * Shows a notification. When user input is requested, resolves with true for "y" and false for "n" or timeout.
 *
 * @param {string} message
 * @param {boolean} reqUserInput
 * @param {number} seconds
 * @return {Promise<boolean>|KuteNotification}
 */
window.kute.showNotification = (message, reqUserInput, seconds) => {
    const notification = new KuteNotification(message, reqUserInput, seconds);
    if (reqUserInput) return notification.promise;

    return notification;
};

export {};
