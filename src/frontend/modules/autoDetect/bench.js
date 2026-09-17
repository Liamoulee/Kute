import { createScene, cpuChecksum, DEFAULT_LOAD } from "./scene.js";
import { FrameRecorder, TaskProbe } from "./metrics.js";

// Page side of `kute.exe --bench=...` (src/modules/bench.rs): runs the synthetic scene in the window,
// measures one settle and one sample window and hands the numbers to the host, which writes them out
// and closes the process. The query string carries the run parameters.

const query = new URLSearchParams(location.search);

/**
 * @param {string} key
 * @param {number} fallback
 * @return {number}
 */
function numberParam(key, fallback){
    const value = Number(query.get(key));
    return query.has(key) && Number.isFinite(value) ? value : fallback;
}

const settleMs = numberParam("settle", 700);
const sampleMs = numberParam("ms", 2000);
const hitchMs = numberParam("hitch", 8);
// frames per second the page holds itself by spinning, like gameFpsLimit.js does when the hook cannot limit
const cap = numberParam("cap", 0);
const step = numberParam("step", 0);
const steps = numberParam("steps", 0);

const load = {
    draws: numberParam("draws", DEFAULT_LOAD.draws),
    meshSegments: DEFAULT_LOAD.meshSegments,
    overdraw: numberParam("overdraw", DEFAULT_LOAD.overdraw),
    cpuIterations: numberParam("cpu", DEFAULT_LOAD.cpuIterations),
};

/**
 * @param {object} result
 */
function finish(result){
    window.chrome.webview.postMessage(`bench-finish ${JSON.stringify(result)}`);
}

/**
 * Runs the scene and reports.
 */
function run(){
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;display:block";
    document.body.append(canvas);

    // started by auto-detect: the window takes no input, so it has to say what it is
    const labelLines = steps > 0 ? ["Kute is testing this PC", `client test ${step} of ${steps}`, "this takes a moment, nothing to do for you"] : [];

    const scene = createScene(canvas, load, labelLines);
    scene.resize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);

    const recorder = new FrameRecorder();
    const tasks = new TaskProbe();
    const start = performance.now();
    let sampling = false;
    let nextSlot = start;

    /**
     * @param {number} timestamp
     */
    const frame = (timestamp) => {
        if (cap > 0){
            while (performance.now() < nextSlot){
                // spin until the frame's slot
            }
            nextSlot = Math.max(nextSlot + 1000 / cap, performance.now());
        }
        const now = performance.now();
        scene.render(timestamp);

        if (!sampling && now - start >= settleMs){
            sampling = true;
            window.chrome.webview.postMessage("bench-sample-start");
            tasks.start();
        }
        if (sampling) recorder.frame(now);

        if (sampling && now - start >= settleMs + sampleMs){
            const otherTasks = tasks.stop();
            const stats = recorder.stats(hitchMs);
            scene.destroy();
            finish({
                ok: true,
                stats,
                otherTasks,
                load,
                width: canvas.width,
                height: canvas.height,
                checksum: cpuChecksum(),
            });
            return;
        }
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}

/**
 * A failed run still has to report, the host waits for it.
 */
function runSafely(){
    try {
        run();
    }
    catch (error){
        finish({ ok: false, error: String(error) });
    }
}

if (document.body) runSafely();
else document.addEventListener("DOMContentLoaded", runSafely, { once: true });
