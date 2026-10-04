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

// keep presenting after the result, the hook answers the host's interval request on its next present
const FINISH_GRACE_MS = 400;

const settleMs = numberParam("settle", 700);
const sampleMs = numberParam("ms", 2000);
const refreshMs = 1000 / numberParam("hz", 60);
const step = numberParam("step", 0);
const steps = numberParam("steps", 0);
// "caps=0.495.330": one sample per cap in this one process, `rounds` times over, 0 = uncapped
const caps = (query.get("caps") ?? "").split(".").filter((part) => part !== "").map(Number).filter(Number.isFinite);
const rounds = numberParam("rounds", 1);
// a new cap needs a moment before the loop runs at it
const capSettleMs = numberParam("capsettle", 700);
// no hook and no chromium limiter: nothing but this page can hold a cap
const selfCap = query.get("selfcap") === "1";

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

function run(){
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;display:block";
    document.body.append(canvas);

    const labelLines = steps > 0 ? ["Kute is testing this PC", `client test ${step} of ${steps}`, "this takes a moment, nothing to do for you"] : [];

    const scene = createScene(canvas, load, labelLines);
    scene.resize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);

    // null: the one sample of a plain bench, at the cap the host set up
    const phases = caps.length > 0 ? Array.from({ length: Math.max(1, rounds) }, () => caps).flat() : [null];
    /** @type {{cap: number, stats: import("./metrics.js").FrameStats|null, otherTasks: ReturnType<TaskProbe["stop"]>}[]} */
    const samples = [];
    let phase = 0;
    let phaseStart = performance.now();
    /** @type {FrameRecorder|null} */
    let recorder = null;
    const tasks = new TaskProbe();
    let cap = numberParam("cap", 0);
    let nextSlot = phaseStart;
    let finishedAt = 0;
    // host closes the window once it has the result, drawing after that just spams "program not valid"
    let contextLost = false;
    canvas.addEventListener("webglcontextlost", () => {
        contextLost = true;
    });

    /**
     * @param {number} now
     */
    const enterPhase = (now) => {
        phaseStart = now;
        recorder = null;
        const value = phases[phase];
        if (value === null) return;
        cap = selfCap ? value : 0;
        nextSlot = now;
        window.chrome.webview.postMessage(`bench-cap ${value}`);
    };
    enterPhase(phaseStart);

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
        // scene.lost() covers a teardown that never fires the event, only asked after the result so the measured loop stays clean
        if (contextLost || (finishedAt > 0 && scene.lost())){
            // before the result: tell the host now instead of letting it time out
            if (finishedAt === 0) finish({ ok: false, error: "webgl context lost" });
            scene.destroy();
            return;
        }
        scene.render(timestamp);

        if (finishedAt > 0){
            if (now - finishedAt < FINISH_GRACE_MS) requestAnimationFrame(frame);
            else scene.destroy();
            return;
        }

        const settle = phase === 0 ? settleMs : capSettleMs;
        if (recorder === null && now - phaseStart >= settle){
            recorder = new FrameRecorder();
            if (phase === 0) window.chrome.webview.postMessage("bench-sample-start");
            tasks.start();
        }
        if (recorder !== null){
            recorder.frame(now);
            if (now - phaseStart >= settle + sampleMs){
                samples.push({ cap: phases[phase] ?? cap, stats: recorder.stats(refreshMs), otherTasks: tasks.stop() });
                phase++;
                if (phase < phases.length){
                    enterPhase(now);
                }
                else {
                    finishedAt = now;
                    finish({
                        ok: true,
                        stats: samples[0].stats,
                        otherTasks: samples[0].otherTasks,
                        // one entry per cap and round, in the order they ran
                        caps: caps.length > 0 ? samples : undefined,
                        load,
                        width: canvas.width,
                        height: canvas.height,
                        checksum: cpuChecksum(),
                    });
                }
            }
        }
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}

// a failed run still has to report, the host waits for it
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
