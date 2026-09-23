import { kute } from "../client.js";

/**
 * Only in the diagnostics build (the host says so in get-info): every 5 s the page's own frame rate next to what
 * the swap chain hook counted over the same window and what the counter shows, plus the window state. The host
 * writes every web message to its log, so this line lands in Downloads\kute-diagnostics.log next to render.dll's
 * table of swap chains.
 */

const WINDOW_MS = 5000;

/**
 * @param {string} message
 * @param {string} key
 * @return {Promise<any>}
 */
const ask = (message, key) => new Promise((resolve) => {
    /**
     * @param {MessageEvent} event
     */
    const listener = (event) => {
        if (event.data?.[key] === undefined) return;
        window.chrome.webview.removeEventListener("message", listener);
        resolve(event.data[key]);
    };
    window.chrome.webview.addEventListener("message", listener);
    window.chrome.webview.postMessage(message);
    setTimeout(() => {
        window.chrome.webview.removeEventListener("message", listener);
        resolve(null);
    }, 1500);
});

let frames = 0;
const tick = () => {
    frames++;
    requestAnimationFrame(tick);
};

const sample = async() => {
    await ask("get-present-intervals", "presentIntervals");
    const started = performance.now();
    frames = 0;
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS));
    const seconds = (performance.now() - started) / 1000;
    const pageFps = frames / seconds;
    const intervals = await ask("get-present-intervals", "presentIntervals");
    const counter = await ask("get-present", "presentFps");
    /** @type {Partial<KrunkerGameActivity>} */
    let activity = {};
    try {
        activity = window.getGameActivity?.() ?? {};
    }
    catch {
        // no game yet
    }
    const report = {
        pageFps: Math.round(pageFps),
        hookPresentsPerSec: intervals && intervals.samples !== undefined ? Math.round(intervals.samples / seconds) : intervals,
        hookP99: intervals?.p99,
        counter,
        // innerText: the present counter module replaces textContent with a setter only. Once in 5 s, the layout
        // read is fine in a diagnostics build
        shown: /** @type {HTMLElement|null} */ (document.querySelector("#ingameFPS"))?.innerText ?? null,
        shownMenu: /** @type {HTMLElement|null} */ (document.querySelector("#menuFPS"))?.innerText ?? null,
        inMatch: Boolean(document.pointerLockElement),
        custom: activity.custom,
        map: activity.map,
        fullscreen: Boolean(document.fullscreenElement),
        size: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
        screen: `${screen.width}x${screen.height}`,
        visible: document.visibilityState,
        frameCap: localStorage.getItem("kro_setngss_updateRate"),
        resolution: localStorage.getItem("kro_setngss_resolution"),
    };
    window.chrome.webview.postMessage(`diag-log ${JSON.stringify(report)}`);
};

if (kute.diagnostics){
    window.chrome.webview.postMessage(`diag-log page ${location.href} bundle ${KUTE_BUNDLE_VERSION} ua ${navigator.userAgent}`);
    requestAnimationFrame(tick);
    const loop = () => {
        sample().catch(() => {}).finally(loop);
    };
    loop();
}
