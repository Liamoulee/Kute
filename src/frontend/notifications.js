import { kute } from "./client.js";
import { getElement } from "./utils.js";

class KuteNotification {
    /**
     * @param {string} message
     * @param {boolean} reqUserInput
     * @param {number} duration seconds
     */
    constructor(message, reqUserInput, duration){
        /** @type {string} */
        this.message = message;
        /** @type {boolean} */
        this.reqUserInput = reqUserInput;
        /** @type {number} */
        this.duration = duration;
        /** @type {HTMLDivElement} */
        this.notificationEl = document.createElement("div");
        this.notificationEl.id = "notification";
        /** @type {number|undefined} */
        this.countdown = undefined;
        /** @type {((event: KeyboardEvent) => void)|undefined} */
        this.handlePromise = undefined;
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
     * @return {Promise<void>}
     */
    async createNotificationElement(){
        const notificationHtml = await import("./components/notification.html");
        this.notificationEl.innerHTML = notificationHtml.default;

        getElement("#notification-content", this.notificationEl).textContent = this.message;
        getElement("#notification-timer", this.notificationEl).textContent = String(this.duration);
        if (this.reqUserInput) getElement("#notification-actions", this.notificationEl).style.display = "block";

        document.body.append(this.notificationEl);
    }

    startTimer(){
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

    hide(){
        clearInterval(this.countdown);
        if (this.handlePromise) document.removeEventListener("keydown", this.handlePromise);
        this.notificationEl.classList.add("slide-out");
        setTimeout(() => this.notificationEl.remove(), 2000);
    }

    show(){
        this.createNotificationElement();
        setTimeout(() => this.notificationEl.classList.add("slide-in"), 10);
        this.startTimer();

        if (this.reqUserInput){
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
 * with reqUserInput: resolves true on y, false on n or timeout
 *
 * @param {string} message
 * @param {boolean} reqUserInput
 * @param {number} seconds
 * @return {Promise<boolean>|KuteNotification}
 */
kute.showNotification = (message, reqUserInput, seconds) => {
    const notification = new KuteNotification(message, reqUserInput, seconds);
    if (reqUserInput) return notification.promise;

    return notification;
};
