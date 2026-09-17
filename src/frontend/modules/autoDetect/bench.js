import { createScene, cpuChecksum, DEFAULT_LOAD } from "./scene.js";
import { FrameRecorder, TaskCounter } from "./metrics.js";

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

    const scene = createScene(canvas, load);
    scene.resize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);

    const recorder = new FrameRecorder();
    const tasks = new TaskCounter();
    const start = performance.now();
    let sampling = false;

    /**
     * @param {number} timestamp
     */
    const frame = (timestamp) => {
        const now = performance.now();
        scene.render(timestamp);

        if (!sampling && now - start >= settleMs){
            sampling = true;
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
                otherTasksPerSec: stats ? otherTasks / stats.seconds : 0,
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
