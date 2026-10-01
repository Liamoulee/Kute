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
 */

// replay.rs CIRCLE_MS: a sample of whole circles leaves the camera where it was
export const REPLAY_CIRCLE_MS = 600;
// fewer pointer events than this and the replay did not reach the page, the wait is unknown then
const MIN_INPUT_EVENTS = 20;

/** @return {InputDiagnostics} */
const emptyDiagnostics = () => ({ readings: 0, asked: 0, withInput: 0, pageEvents: 0, hostSteps: 0, ended: {} });
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
        let valid = focused();

        // rAF never fires on a page that stopped drawing, don't hang the run
        const watchdog = setTimeout(() => {
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
            const task = tasks.stop();
            const pointer = input.stop();
            const stats = frames.stats(1000 / hz);
            diagnostics.pageEvents += pointer.events;
            if (pointer.events >= MIN_INPUT_EVENTS) diagnostics.withInput++;
            // lost focus or the pointer mid window: the numbers describe something else
            valid = valid && focused() && (document.pointerLockElement !== null) === lockedAtStart;
            resolve({
                fps: stats?.fps ?? null,
                p50: stats?.p50 ?? null,
                p99: stats?.p99 ?? null,
                maxMs: stats?.maxMs ?? null,
                stallMs: stats?.stallMs ?? null,
                taskP99: task.p99,
                inputP99: pointer.events >= MIN_INPUT_EVENTS ? pointer.p99 : null,
                invalid: !valid || stats === null,
            });
        };
        requestAnimationFrame(frame);
    });
}
