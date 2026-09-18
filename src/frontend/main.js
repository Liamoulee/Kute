import styles from "./components/base.css";
import { kute, ready } from "./client.js";
import { hook, getElement, checkCompMode } from "./utils.js";
// first, so that whatever throws further down gets heard of
import "./modules/errorReports.js";

const isBenchPage = location.pathname === "/kute-bench";
if (isBenchPage) import("./modules/autoDetect/bench.js");

let initialLoad = true;
window.OffCliV = true;
/**
 * Asks the host to close the client window.
 */
window.closeClient = () => window.chrome.webview.postMessage("close");

document.addEventListener(
    "DOMContentLoaded",
    () => {
        if (isBenchPage) return;

        // load noticeable style changes and stuff that requires hooks earlier
        window.localStorage.setItem("cont_shoot1Key_alt", "131");
        import("./modules/gameFpsLimit.js");
        import("./modules/logoBadge.js");

        const baseCSS = document.createElement("style");
        baseCSS.textContent = styles;
        document.head.append(baseCSS);

        /** @type {((event: WheelEvent) => void)|null} */
        let wheelListener = null;
        hook(HTMLCanvasElement, "addEventListener", (args) => {
            const [type, listener] = args;
            if (type === "wheel") wheelListener = listener;
        });

        // the host forwards WM_MOUSEWHEEL as {wheel: deltaY} while the mouse is captured by the game
        window.chrome.webview.addEventListener("message", (event) => {
            if (typeof event.data?.wheel === "number") wheelListener?.(new WheelEvent("wheel", { deltaY: event.data.wheel }));
        });

        hook(HTMLCanvasElement, "requestPointerLock", function(args, original){
            window.chrome.webview.postMessage("drag, false");
            window.chrome.webview.postMessage("throttle, game");

            return original.call(this, { ...args[0], unadjustedMovement: kute?.settings?.data?.rawInput });
        });

        document.addEventListener("pointerlockchange", () => {
            if (!document.pointerLockElement){
                window.chrome.webview.postMessage("drag, true");
                window.chrome.webview.postMessage("throttle, menu");
            }
            else {
                // JUST in case showWindow ids or requestPointerLock hook misses transition
                window.chrome.webview.postMessage("throttle, game");
            }
        });

        // the settings come from the host and may not be here yet when the document is
        ready.then(() => {
            if (!kute.settings.data.cleanUI) return;
            import("./components/clean.css").then((css) => {
                const cleanCSS = document.createElement("style");
                cleanCSS.id = "kute_cleanCSS";
                cleanCSS.textContent = css.default;
                document.head.append(cleanCSS);
            });
        });
    },
    { once: true },
);

Object.defineProperty(window, "gameLoaded", {
    /**
     * Main init point. Runs once the game reports loaded and imports the modules gated by settings.
     *
     * @param {boolean} value
     */
    async set(value){
        if (!value) return;

        await ready;

        window.chrome.webview.postMessage("game-updated");
        if (!initialLoad) return;
        if (sessionStorage.getItem("justLaunched") === null) sessionStorage.setItem("justLaunched", "true");
        else sessionStorage.setItem("justLaunched", "false");

        initialLoad = false;
        // console is disabled without this
        localStorage.setItem("logs", "true");

        window.windows[0].toggleType({ checked: true });

        // append ranked and mod button to comp host ui
        // insertAdjacentHTML: "innerHTML +=" rebuilds the buttons that are already there, listeners and all
        getElement("#compBtnLst").insertAdjacentHTML("beforeend", `
		    <div class="compMenBtnS" onmouseenter='SOUND.play("tick_0",.1)' style="background-color: #f5479b" onclick="playSelect(),showWindow(4)"> <span class="material-icons" style="color:#fff;font-size:40px;vertical-align:middle;margin-bottom:12px">color_lens</span></div>
		    <div class="compMenBtnS" onmouseenter='SOUND.play("tick_0",.1)' style="background-color: #5ce05a" onclick="playSelect(),window.openRankedMenu()"><span class="material-icons" style="color:#fff;font-size:40px;vertical-align:middle;margin-bottom:12px">star</span></div>`);

        // classic social button
        /** @type {string|undefined} */
        let svelteCode;
        for (const cl of getElement("#clientExit .menuItemTitle").classList){
            if (cl.startsWith("svelte-")){
                svelteCode = cl;
                break;
            }
        }

        getElement("#menuItemContainer").lastElementChild?.insertAdjacentHTML(
            "beforebegin",
            `<div onclick="window.open('./social.html')" class="menuItem ${svelteCode}"><span class="material-icons-outlined menuItemIcon ${svelteCode}">open_in_new</span><div class="menuItemTitle ${svelteCode}">Classic Social</div></div>`,
        );
        import("./notifications.js");
        import("./settings.js");
        import("./modules/changelog.js");
        import("./modules/about.js");
        import("./modules/autoDetect/index.js");
        if (kute?.settings?.data?.clanColors !== false) import("./modules/clanColors.js");
        // always: the setting only decides whether badges get drawn, the client announces itself either way
        import("./modules/badges.js");
        import("./modules/externalQueue.js");
        import("./modules/bpClaimAll.js");
        import("./modules/args.js");
        import("./modules/fixes.js");
        import("./modules/rankProgress.js");
        import("./modules/importSettings.js");
        if (kute?.settings?.data?.hsSound) import("./modules/hsSound.js");
        if (kute?.settings?.data?.betterChat) import("./modules/betterChat.js");
        if (kute?.settings?.data?.hpEnemyCounter) import("./modules/hpEnemyCounter.js");
        if (kute?.settings?.data?.accountManager) import("./modules/accountManager.js");
        if (kute?.settings?.data?.showPing) import("./modules/showPing.js");
        if (kute?.settings?.data?.realPing) import("./modules/realPing.js");
        if (kute?.settings?.data?.exitButton) getElement("#clientExit").style.display = "flex";
        if (kute?.settings?.data?.renderStats) import("./modules/renderFps.js");

        if (kute?.settings?.data?.rampBoost && !checkCompMode()){
            window.chrome.webview.postMessage("toggle-rboost, true");

            /**
             * Turns ramp boost back off once a comp match is detected.
             *
             * @param {MessageEvent} event
             */
            const gameUpdateListener = (event) => {
                if (event.data === "game-updated"){
                    setTimeout(() => {
                        if (checkCompMode()){
                            window.chrome.webview.removeEventListener("message", gameUpdateListener);
                            window.chrome.webview.postMessage("toggle-rboost, false");
                        }
                    }, 2000);
                }
            };

            window.chrome.webview.addEventListener("message", gameUpdateListener);
        }

        if (kute?.settings.data?.hideBundles){
            const origBundlePopup = window.bundlePopup;
            window.bundlePopup = (...args) => {
                const windowHolder = /** @type {HTMLElement|null} */ (document.querySelector("#windowHolder"));
                if (
                    windowHolder &&
                    windowHolder.style.display !== "none" &&
                    getElement("#windowHeader").textContent === "Store"
                ){
                    origBundlePopup(...args);
                }
            };
        }

        setTimeout(() => {
            if (sessionStorage.getItem("justLaunched") === "true" && kute?.launchArgs){
                kute.parseArgs(kute.launchArgs);
            }
        }, 2000);

        if (kute?.settings.data?.autoSpec){
            /**
             * Enables spectating as soon as the game activity reports a map, unless the game is custom.
             */
            let tries = 0;
            const trySetSpect = () => {
                const activity = window.getGameActivity();
                if (activity.map === null){
                    // a minute, not forever: without a map this kept a 10 Hz timer alive for the whole session
                    if (++tries < 600) setTimeout(trySetSpect, 100);
                    return;
                }
                if (!activity.custom) window.setSpect(true);
            };
            trySetSpect();
        }

        if (kute?.settings.data?.discordRPC){
            window.chrome.webview.addEventListener("message", (event) => {
                if (event.data !== "game-updated") return;
                setTimeout(() => {
                    const gameStatus = window.getGameActivity();
                    window.chrome.webview.postMessage(`rpc-update, ${gameStatus.mode}, ${gameStatus.map}`);
                }, 2000);
            });
        }

        if (kute?.settings.data?.textSelect){
            const textSelectCSS = document.createElement("style");
            textSelectCSS.id = "kute_textSelectCSS";
            textSelectCSS.textContent = "#chatHolder * { user-select: text }";
            document.head.append(textSelectCSS);
        }

        if (kute?.settings.data?.menuTimer){
            import("./components/menuTimer.css").then((module) => {
                const menuTimerCSS = document.createElement("style");
                menuTimerCSS.id = "kute_menuTimerCSS";
                menuTimerCSS.textContent = module.default;
                document.head.append(menuTimerCSS);
            });
        }
    },
});
