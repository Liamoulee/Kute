import { createScene, cpuChecksum, DEFAULT_LOAD } from "./scene.js";
import { FrameRecorder, TaskProbe } from "./metrics.js";

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

/**
 * How long the scene keeps drawing after the result went out. The host answers `bench-finish` by asking the
 * present hook for its interval distribution, and the hook only answers that on its next Present. Tearing the
 * scene down first stopped the presents, so the request waited out its 150 ms and the row came back without
 * any present numbers. The process exits on its own about a second later.
 */
const FINISH_GRACE_MS = 400;

const settleMs = numberParam("settle", 700);
const sampleMs = numberParam("ms", 2000);
const hitchMs = numberParam("hitch", 8);
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

    const labelLines = steps > 0 ? ["Kute is testing this PC", `client test ${step} of ${steps}`, "this takes a moment, nothing to do for you"] : [];

    const scene = createScene(canvas, load, labelLines);
    scene.resize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);

    const recorder = new FrameRecorder();
    const tasks = new TaskProbe();
    const start = performance.now();
    let sampling = false;
    let finishedAt = 0;
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

        if (finishedAt > 0){
            if (now - finishedAt < FINISH_GRACE_MS) requestAnimationFrame(frame);
            else scene.destroy();
            return;
        }

        if (!sampling && now - start >= settleMs){
            sampling = true;
            window.chrome.webview.postMessage("bench-sample-start");
            tasks.start();
        }
        if (sampling) recorder.frame(now);

        if (sampling && now - start >= settleMs + sampleMs){
            const otherTasks = tasks.stop();
            const stats = recorder.stats(hitchMs);
            finishedAt = now;
            finish({
                ok: true,
                stats,
                otherTasks,
                load,
                width: canvas.width,
                height: canvas.height,
                checksum: cpuChecksum(),
            });
            requestAnimationFrame(frame);
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
