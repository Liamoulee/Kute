import { kute } from "../client.js";
import { confirmPopup } from "./confirmPopup.js";

// once per version and tab, a new lobby reloads the page
const ASKED_KEY = "kute_update_asked";
const READY_KEY = "kute_update_ready";
// progress notifications at these shares, not on every message
const PROGRESS_STEPS = [0.25, 0.5, 0.75];

/**
 * @typedef {object} UpdateState
 * @property {"offer"|"downloading"|"ready"|"failed"} stage
 * @property {string} version
 * @property {string} [current]
 * @property {boolean} [install] runs as an AppImage and the release has one
 * @property {number|null} [size]
 * @property {number} [done]
 * @property {number} [total]
 * @property {string} [error]
 */

/**
 * resolves once the game does not hold the pointer, a popup never lands in a fight
 *
 * @return {Promise<void>}
 */
const inMenu = () => new Promise((resolve) => {
    const check = () => {
        if (!document.pointerLockElement) resolve();
        else setTimeout(check, 2000);
    };
    check();
});

/**
 * @param {number} bytes
 * @return {string}
 */
const megabytes = (bytes) => `${Math.round(bytes / 1048576)} MB`;

class LinuxUpdate {
    constructor(){
        this.step = 0;
        this.busy = false;
        if (kute.platform !== "linux" || !kute.hostFeatures?.includes("appimage-update")) return;

        window.chrome.webview.addEventListener("message", (event) => {
            const update = /** @type {{update?: UpdateState}} */ (event.data)?.update;
            if (update && typeof update === "object") this.receive(update).catch(() => {});
        });
        // the check may have finished before this page loaded
        window.chrome.webview.postMessage("update-state");
    }

    /**
     * @param {UpdateState} update
     */
    async receive(update){
        if (update.stage === "offer") await this.offer(update);
        else if (update.stage === "downloading") this.progress(update);
        else if (update.stage === "ready") await this.ready(update);
        else if (update.stage === "failed"){
            kute.showNotification(`The update to Kute ${update.version} failed: ${update.error ?? "unknown error"}`, false, 8);
        }
    }

    /**
     * @param {UpdateState} update
     */
    async offer(update){
        if (this.busy || sessionStorage.getItem(ASKED_KEY) === update.version) return;
        this.busy = true;
        await inMenu();
        sessionStorage.setItem(ASKED_KEY, update.version);
        const install = update.install === true;
        const yes = await confirmPopup({
            title: `Kute ${update.version} is out`,
            paragraphs: install
                ? [
                    `You have ${update.current}. The update${update.size ? ` (${megabytes(update.size)})` : ""} downloads while you play.`,
                    "It replaces your Kute AppImage and starts the next time you open Kute.",
                ]
                : [
                    `You have ${update.current}.`,
                    "This copy of Kute does not run as an AppImage and cannot update itself. The download page has the new version.",
                ],
            stay: "Later",
            leave: install ? "Update" : "Open download page",
        });
        this.busy = false;
        if (!yes) return;
        window.chrome.webview.postMessage(install ? "update-install" : "update-page");
        if (install) kute.showNotification(`Downloading Kute ${update.version}`, false, 4);
    }

    /**
     * @param {UpdateState} update
     */
    progress(update){
        if (!update.total || !update.done) return;
        const share = update.done / update.total;
        while (this.step < PROGRESS_STEPS.length && share >= PROGRESS_STEPS[this.step]){
            kute.showNotification(`Downloading Kute ${update.version}: ${Math.round(PROGRESS_STEPS[this.step] * 100)} %`, false, 3);
            this.step++;
        }
    }

    /**
     * @param {UpdateState} update
     */
    async ready(update){
        if (sessionStorage.getItem(READY_KEY) === update.version) return;
        await inMenu();
        sessionStorage.setItem(READY_KEY, update.version);
        const restart = await confirmPopup({
            title: `Kute ${update.version} is ready`,
            paragraphs: ["It starts the next time you open Kute. Restart now to use it right away."],
            stay: "Later",
            leave: "Restart now",
        });
        if (restart) window.chrome.webview.postMessage("update-restart");
    }
}

export default new LinuxUpdate();
