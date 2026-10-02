import { FrameRecorder, InputProbe, TaskProbe } from "./metrics.js";

/**
 * @typedef {import("./policy.js").Reading} Reading
 */

/**
 * @typedef {object} InputDiagnostics did the host's input script reach the game, and if not, where it stopped
 * @property {number} readings
 * @property {number} asked readings that asked the host for input (the game held the mouse)
 * @property {number} withInput readings that saw enough pointer events to judge the wait
 * @property {number} pageEvents pointer events the page saw
 * @property {number} hostSteps input steps the host sent
 * @property {Record<string, number>} ended how the host's scripts ended, by reason
 * @property {Record<string, number>} invalid readings that say nothing, by reason
 */

// replay.rs CIRCLE_MS: a sample of whole circles leaves the camera where it was
export const REPLAY_CIRCLE_MS = 600;
// fewer pointer events than this and the replay did not reach the page, the wait is unknown then
const MIN_INPUT_EVENTS = 20;

/** @return {InputDiagnostics} */
const emptyDiagnostics = () => ({ readings: 0, asked: 0, withInput: 0, pageEvents: 0, hostSteps: 0, ended: {}, invalid: {} });
let diagnostics = emptyDiagnostics();

// a report with no pointer wait in it could not say why (an AMD desktop, 2026-10-01): the host tells how each script ended
window.chrome.webview.addEventListener("message", (event) => {
    const result = event.data?.inputReplay;
    if (!result) return;
    diagnostics.hostSteps += Number(result.sent) || 0;
    diagnostics.ended[result.reason] = (diagnostics.ended[result.reason] ?? 0) + 1;
});

/**
 * @return {InputDiagnostics} everything since the last call
 */
export function takeInputDiagnostics(){
    const taken = diagnostics;
    diagnostics = emptyDiagnostics();
    return taken;
}

/**
 * one measurement window of the running game: frames, main thread task delay and pointer wait together.
 * with `replay` the host turns the camera and fires for the window (real input, the same script every time)
 *
 * @param {{ms: number, hz: number, replay: boolean}} options
 * @return {Promise<Reading>}
 */
export function takeReading({ ms, hz, replay }){
    return new Promise((resolve, reject) => {
        const frames = new FrameRecorder();
        const tasks = new TaskProbe();
        const input = new InputProbe();
        const focused = () => document.hasFocus() && document.visibilityState === "visible";
        const lockedAtStart = document.pointerLockElement !== null;
        /** @type {string|null} */
        let invalidWhy = focused() ? null : "the window was not in front";
        // latched: a window that lost focus and got it back inside the reading measured something else in between
        const onFocus = () => {
            if (!focused()) invalidWhy ??= "the window lost focus";
        };
        const onLock = () => {
            if ((document.pointerLockElement !== null) !== lockedAtStart) invalidWhy ??= lockedAtStart ? "the game let go of the mouse" : "the game took the mouse";
        };
        const unwatch = () => {
            window.removeEventListener("blur", onFocus);
            document.removeEventListener("visibilitychange", onFocus);
            document.removeEventListener("pointerlockchange", onLock);
        };
        window.addEventListener("blur", onFocus);
        document.addEventListener("visibilitychange", onFocus);
        document.addEventListener("pointerlockchange", onLock);

        // rAF never fires on a page that stopped drawing, don't hang the run
        const watchdog = setTimeout(() => {
            unwatch();
            tasks.stop();
            input.stop();
            window.chrome.webview.postMessage("input-replay-stop");
            reject(new Error("the game stopped drawing frames"));
        }, ms + 5000);

        tasks.start();
        input.start();
        diagnostics.readings++;
        if (replay && lockedAtStart){
            diagnostics.asked++;
            window.chrome.webview.postMessage(`input-replay, ${ms}`);
        }
        const start = performance.now();
        const frame = () => {
            const now = performance.now();
            frames.frame(now);
            if (now - start < ms){
                requestAnimationFrame(frame);
                return;
            }
            clearTimeout(watchdog);
            unwatch();
            onFocus();
            onLock();
            const task = tasks.stop();
            const pointer = input.stop();
            const stats = frames.stats(1000 / hz);
            diagnostics.pageEvents += pointer.events;
            if (pointer.events >= MIN_INPUT_EVENTS) diagnostics.withInput++;
            if (stats === null) invalidWhy ??= "too few frames";
            if (invalidWhy !== null) diagnostics.invalid[invalidWhy] = (diagnostics.invalid[invalidWhy] ?? 0) + 1;
            resolve({
                fps: stats?.fps ?? null,
                p50: stats?.p50 ?? null,
                p99: stats?.p99 ?? null,
                maxMs: stats?.maxMs ?? null,
                stallMs: stats?.stallMs ?? null,
                taskP99: task.p99,
                inputP99: pointer.events >= MIN_INPUT_EVENTS ? pointer.p99 : null,
                invalid: invalidWhy !== null,
                ...(invalidWhy === null ? {} : { why: invalidWhy }),
            });
        };
        requestAnimationFrame(frame);
    });
}
