import { kute } from "../client.js";

// the page half of the host's dev only flight recorder (src/modules/perf_recorder.rs): on F8 it marks the moment in the
// Chromium trace and hands the host what only the page knows. only reacts to host messages, so it costs nothing
// while nobody presses F8, and a normal client never sends them

/**
 * @return {Record<string, any>}
 */
function pageContext(){
    /** @type {Record<string, any>|null} */
    let activity = null;
    try {
        const game = window.getGameActivity();
        activity = { id: game.id, mode: game.mode, map: game.map, custom: game.custom };
    }
    catch {
        // not a game page, or the game is not loaded yet
    }
    const canvas = document.querySelector("canvas");
    const { memory } = /** @type {any} */ (performance);
    return {
        url: location.href,
        activity,
        players: document.querySelectorAll("#leaderContainer .leaderItem").length,
        pointerLocked: Boolean(document.pointerLockElement),
        focused: document.hasFocus(),
        hidden: document.hidden,
        // converts the page clock into the trace: the "kute-f8" TimeStamp event sits at this performance.now()
        performanceNow: performance.now(),
        timeOrigin: performance.timeOrigin,
        window: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
        canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
        jsHeapMb: memory ? Math.round(memory.usedJSHeapSize / 1048576) : null,
        cores: navigator.hardwareConcurrency,
    };
}

window.chrome.webview.addEventListener("message", (event) => {
    const capture = event.data?.perfCapture;
    if (capture === "mark"){
        console.timeStamp("kute-f8");
        window.chrome.webview.postMessage("perf-context " + JSON.stringify(pageContext()));
    }
    else if (capture === "saved"){
        const where = String(event.data.dir ?? "").split("\\").slice(-2).join("\\");
        kute.showNotification?.(event.data.traced ? `Performance capture saved: ${where}` : `Capture failed, only context saved: ${where}`, false, 5);
    }
});
