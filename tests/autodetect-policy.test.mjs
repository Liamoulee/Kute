import { describe, expect, test } from "bun:test";
import { accept, atLimit, capCandidates, choose, chooseCap, collapses, compare, experienceHolds, flooding, guard, headroom, refineCaps, screen, stalled, steady, steadyLimit, steadyRungs, summarize, wins } from "../src/frontend/modules/autoDetect/policy.js";

/**
 * @param {Partial<import("../src/frontend/modules/autoDetect/policy.js").Reading>} values
 * @return {import("../src/frontend/modules/autoDetect/policy.js").Reading}
 */
function reading(values){
    return { fps: null, p99: null, maxMs: null, stallMs: null, taskP99: null, inputP99: null, ...values };
}

/**
 * @param {Partial<import("../src/frontend/modules/autoDetect/policy.js").Reading>} values
 * @return {import("../src/frontend/modules/autoDetect/policy.js").Reading[]} the same reading twice
 */
const twice = (values) => [reading(values), reading(values)];
/**
 * @param {number} fps
 * @param {Partial<import("../src/frontend/modules/autoDetect/policy.js").Reading>} [values]
 * @return {import("../src/frontend/modules/autoDetect/policy.js").Reading} a clean reading at this frame rate
 */
const clean = (fps, values = {}) => reading({ fps, p50: 1000 / fps, p99: 1000 / fps + 0.5, maxMs: 1000 / fps + 1, inputP99: 1000 / fps + 0.5, taskP99: 2, stallMs: 0, ...values });

// the hybrid laptop of 2026-09-30 (RTX 5060 Laptop, 165 Hz): the old rules kept the hook
const hookOn = [reading({ fps: 707, p99: 2.0, maxMs: 2.3, taskP99: 2.4 }), reading({ fps: 701, p99: 2.1, maxMs: 2.3, taskP99: 2.3 })];
const hookOff = [reading({ fps: 1397, p99: 1.2, maxMs: 1.7, taskP99: 2.2 }), reading({ fps: 1380, p99: 1.2, maxMs: 1.8, taskP99: 2.1 })];

describe("choose", () => {
    test("the tester's laptop switches the hook off", () => {
        const choice = choose({ id: "hook=1", readings: hookOn }, [{ id: "hook=0", readings: hookOff }]);
        expect(choice.winner).toBe("hook=0");
        expect(choice.changed).toBe(true);
        expect(choice.decidedBy).toBe("p99");
    });

    test("more frames never buy a lag regression", () => {
        const incumbent = [reading({ fps: 500, p99: 2.4, taskP99: 1.8 }), reading({ fps: 500, p99: 2.3, taskP99: 1.9 })];
        const busyWait = [reading({ fps: 900, p99: 2.0, taskP99: 10.9 }), reading({ fps: 910, p99: 2.0, taskP99: 11.0 })];
        const choice = choose({ id: "limiter", readings: incumbent }, [{ id: "busy", readings: busyWait }]);
        expect(choice.judged[0].rejected).toBe(true);
        expect(choice.winner).toBe("limiter");
    });

    test("one reading each is inconclusive, the incumbent stays", () => {
        const choice = choose({ id: "a", readings: [hookOn[0]] }, [{ id: "b", readings: [hookOff[0]] }]);
        expect(choice.inconclusive).toBe(true);
        expect(choice.changed).toBe(false);
    });

    test("a metric nobody measured never wins", () => {
        const known = [reading({ fps: 700, p99: 2.0, taskP99: 2.0 }), reading({ fps: 700, p99: 2.0, taskP99: 2.1 })];
        const blind = [reading({ fps: 700, p99: 2.0 }), reading({ fps: 700, p99: 2.0 })];
        const choice = choose({ id: "known", readings: known }, [{ id: "blind", readings: blind }]);
        expect(choice.judged[0].verdicts.taskP99).toBe("unknown");
        expect(choice.changed).toBe(false);
    });

    test("an invalid window is not a reading", () => {
        const withInvalid = [...hookOff, reading({ fps: 60, p99: 40, invalid: true })];
        expect(summarize(withInvalid).p99.median).toBe(1.2);
    });

    test("the earliest experience metric decides between two improving candidates", () => {
        const incumbent = [reading({ p99: 5.0, taskP99: 6.0 }), reading({ p99: 5.1, taskP99: 6.1 })];
        const smoother = [reading({ p99: 3.0, taskP99: 6.0 }), reading({ p99: 3.1, taskP99: 6.1 })];
        const lessLag = [reading({ p99: 5.0, taskP99: 2.0 }), reading({ p99: 5.1, taskP99: 2.1 })];
        const choice = choose({ id: "now", readings: incumbent }, [{ id: "smoother", readings: smoother }, { id: "lessLag", readings: lessLag }]);
        expect(choice.winner).toBe("lessLag");
        expect(choice.decidedBy).toBe("taskP99");
    });
});

describe("chooseCap", () => {
    /**
     * @param {number} p50
     * @param {number} taskP99
     * @param {number} [jitter] slowest frames beyond the typical one
     * @return {import("../src/frontend/modules/autoDetect/policy.js").Reading[]} two readings a hair apart
     */
    const at = (p50, taskP99, jitter = 0.5) => [
        reading({ fps: 1000 / p50, p50, p99: p50 + jitter, maxMs: p50 + jitter + 0.2, stallMs: 0, taskP99 }),
        reading({ fps: 1000 / p50, p50, p99: p50 + jitter + 0.05, maxMs: p50 + jitter + 0.3, stallMs: 0, taskP99: taskP99 + 0.1 }),
    ];

    test("a fast pc stays uncapped: 0.8 ms less delay does not pay for 4.9 ms more frame time", () => {
        // this desktop in the test match, 2026-10-01
        const choice = chooseCap(new Map([[0, at(0.7, 2.35)], [180, at(5.55, 1.55)]]), 0);
        expect(choice.changed).toBe(false);
        expect(choice.judged.find((entry) => entry.cap === 180)?.outcome).toBe("not better");
    });

    test("a pc whose frames starve everything else gets the cap", () => {
        // the bench scene at eight times its load, same day: uncapped 8.15 ms task delay, 2.6 at a 180 cap
        const choice = chooseCap(new Map([[0, at(3.5, 8.15)], [180, at(5.55, 2.6)], [60, at(16.7, 3.35)]]), 0);
        expect(choice.winner).toBe(180);
        expect(choice.decidedBy).toBe("net");
        expect(choice.judged.find((entry) => entry.cap === 60)?.outcome).toBe("not better");
    });

    test("lifting a cap wins when nothing gets worse", () => {
        const choice = chooseCap(new Map([[235, at(4.25, 1.5)], [0, at(1.2, 1.5)]]), 235);
        expect(choice.winner).toBe(0);
    });

    test("lifting a cap loses when the delay it brings back is bigger than the frame time it saves", () => {
        const choice = chooseCap(new Map([[235, at(4.25, 1.5)], [0, at(1.2, 9)]]), 235);
        expect(choice.changed).toBe(false);
        expect(choice.judged.find((entry) => entry.cap === 0)?.outcome).toBe("worse");
    });

    test("a laptop takes its target rate when it measures the same as uncapped, a desktop does not", () => {
        const readings = new Map([[0, at(1.2, 1.5)], [495, at(2.02, 1.5)], [165, at(6.06, 1.5)]]);
        expect(chooseCap(readings, 0).changed).toBe(false);
        const laptop = chooseCap(readings, 0, { prefer: 495 });
        expect(laptop.winner).toBe(495);
        expect(laptop.decidedBy).toBe("tie");
    });

    test("a cap that stalls more is out, whatever else it gains", () => {
        const stalling = at(5.55, 2.6).map((entry) => ({ ...entry, stallMs: 40 }));
        const choice = chooseCap(new Map([[0, at(3.5, 8.15)], [180, stalling]]), 0);
        expect(choice.changed).toBe(false);
        expect(choice.judged.find((entry) => entry.cap === 180)?.outcome).toBe("worse");
    });

    /**
     * @param {Partial<import("../src/frontend/modules/autoDetect/policy.js").Reading>} values
     * @return {import("../src/frontend/modules/autoDetect/policy.js").Reading[]}
     */
    const both = (values) => [reading(values), reading(values)];

    test("a longer frame is paid once: equal waits are no gain for the lower limit", () => {
        // 500 fps with its slowest frames at 4 ms against a flat 250: nothing reaches the player sooner at 250
        const uncapped = both({ fps: 500, p50: 2, p99: 4, maxMs: 6, stallMs: 0, taskP99: 4, inputP99: 4 });
        const capped = both({ fps: 250, p50: 4, p99: 4, maxMs: 6, stallMs: 0, taskP99: 4, inputP99: 4 });
        const choice = chooseCap(new Map([[0, uncapped], [250, capped]]), 0);
        expect(choice.changed).toBe(false);
        expect(choice.judged.find((entry) => entry.cap === 250)?.netMs).toBe(0);
    });

    test("a limit that makes the mouse wait longer is out, even when tasks run sooner", () => {
        const uncapped = both({ fps: 500, p50: 2, p99: 2.5, maxMs: 3, stallMs: 0, taskP99: 6, inputP99: 2.5 });
        const capped = both({ fps: 180, p50: 5.55, p99: 6, maxMs: 6.5, stallMs: 0, taskP99: 2, inputP99: 6 });
        expect(chooseCap(new Map([[0, uncapped], [180, capped]]), 0).judged.find((entry) => entry.cap === 180)?.outcome).toBe("worse");
    });

    test("a limit wins on measured waits: tasks sooner, the mouse no later", () => {
        const uncapped = both({ fps: 285, p50: 3.5, p99: 4, maxMs: 5, stallMs: 0, taskP99: 8.2, inputP99: 6.1 });
        const capped = both({ fps: 180, p50: 5.55, p99: 6, maxMs: 6.5, stallMs: 0, taskP99: 2.6, inputP99: 6.0 });
        const choice = chooseCap(new Map([[0, uncapped], [180, capped]]), 0);
        expect(choice.winner).toBe(180);
        expect(choice.judged.find((entry) => entry.cap === 180)?.gains?.input).toBe(0);
        expect(choice.judged.find((entry) => entry.cap === 180)?.netMs).toBeCloseTo(5.6);
    });

    test("frames that never reach the screen: the target rate measures equal and takes over", () => {
        // the old auto-detect capped 1000 drawn / 200 shown frames at 3x a 60 Hz screen, v2 could not see it
        const flooded = twice(clean(1000, { presentMs: 5 }));
        const capped = twice(clean(180, { presentMs: 1000 / 180 }));
        const choice = chooseCap(new Map([[0, flooded], [180, capped]]), 0, { prefer: 180, inputRequired: true });
        expect(choice.winner).toBe(180);
        expect(chooseCap(new Map([[0, twice(clean(1000))], [180, capped]]), 0, { prefer: 180, inputRequired: true }).changed).toBe(false);
    });

    test("in the match a lower limit is not judged without a mouse wait", () => {
        const blind = (/** @type {number} */ p50, /** @type {number} */ taskP99) => at(p50, taskP99).map((entry) => ({ ...entry, inputP99: null }));
        const readings = new Map([[0, blind(3.5, 8.15)], [180, blind(5.55, 2.6)]]);
        expect(chooseCap(readings, 0).winner).toBe(180);
        const inMatch = chooseCap(readings, 0, { inputRequired: true });
        expect(inMatch.changed).toBe(false);
        expect(inMatch.judged.find((entry) => entry.cap === 180)?.netMs).toBe(null);
    });

    test("one reading per cap decides nothing", () => {
        const choice = chooseCap(new Map([[0, at(3.5, 8.15).slice(0, 1)], [180, at(5.55, 2.6).slice(0, 1)]]), 0, { prefer: 180 });
        expect(choice.changed).toBe(false);
        expect(choice.judged.find((entry) => entry.cap === 180)?.netMs).toBe(null);
    });
});

describe("atLimit", () => {
    test("frame spikes count from the reading's own typical frame, the waits stay as measured", () => {
        const result = atLimit(reading({ fps: 180, p50: 5.5, p99: 6.0, maxMs: 6.5, inputP99: 7.0, taskP99: 2 }));
        expect(result.p99).toBeCloseTo(0.5);
        expect(result.maxMs).toBeCloseTo(1.0);
        expect(result.inputP99).toBe(7.0);
        expect(result.taskP99).toBe(2);
        expect(result.fps).toBe(null);
    });

    test("frames that never reach the screen make the mouse wait for the next one that does", () => {
        // the old auto-detect's case: the game draws 1000 frames a second, the hook sees 200 presented
        const flooded = reading({ fps: 1000, p50: 1, p99: 1.5, maxMs: 2, inputP99: 1.5, taskP99: 2, presentMs: 5 });
        expect(flooding(flooded)).toBe(true);
        expect(atLimit(flooded).inputP99).toBeCloseTo(5.5);
        expect(flooding(reading({ fps: 1000, p50: 1, presentMs: 1.05 }))).toBe(false);
        expect(flooding(reading({ fps: 1000, p50: 1 }))).toBe(false);
    });
});

describe("guard", () => {
    test("a candidate's own spread does not hide its regression", () => {
        // release review 2026-10-02: readings of 100 and 900 fps were "the same" as a steady 500 and won on task delay
        const steadyBase = [clean(500), clean(500)];
        const noisy = [clean(100, { taskP99: 0.5, inputP99: null }), clean(900, { taskP99: 0.5, inputP99: null })];
        expect(compare("p99", summarize(noisy), summarize(steadyBase))).toBe("same");
        expect(guard("p99", summarize(noisy), summarize(steadyBase))).toBe("worse");
        expect(choose({ id: "old", readings: steadyBase }, [{ id: "new", readings: noisy }]).winner).toBe("old");
    });

    test("the incumbent's own spread is the tolerance, and one reading is no evidence", () => {
        const base = summarize([clean(500, { taskP99: 2 }), clean(500, { taskP99: 3 })]);
        expect(guard("taskP99", summarize(twice({ taskP99: 3.4 })), base)).toBe("ok");
        expect(guard("taskP99", summarize(twice({ taskP99: 4 })), base)).toBe("worse");
        expect(guard("taskP99", summarize([reading({ taskP99: 1 })]), base)).toBe("unknown");
        expect(guard("taskP99", summarize(twice({ taskP99: 1 })), summarize([clean(500)]))).toBe("unknown");
    });
});

describe("wins", () => {
    test("single frames that happen to be shorter do not win a restart", () => {
        // this desktop, 2026-10-02, bench scene: "WebGL Buffer Cache off" won on its longest frame and restarted the client
        const base = summarize([reading({ fps: 545, p99: 2.2, maxMs: 3.6 }), reading({ fps: 545, p99: 2.5, maxMs: 3.8 }), reading({ fps: 549, p99: 2.2, maxMs: 3.1 })]);
        const flip = [reading({ fps: 549, p99: 2.1, maxMs: 2.2 }), reading({ fps: 548, p99: 2.1, maxMs: 3.0 })];
        expect(compare("maxMs", summarize(flip), base)).toBe("better");
        expect(wins("maxMs", summarize(flip), base)).toBe(false);
        expect(choose({ id: "current", readings: [reading({ fps: 545, p99: 2.2, maxMs: 3.6 }), reading({ fps: 545, p99: 2.5, maxMs: 3.8 }), reading({ fps: 549, p99: 2.2, maxMs: 3.1 })] }, [{ id: "flip", readings: flip }]).changed).toBe(false);
    });

    test("every reading clearly ahead of the incumbent's best wins", () => {
        expect(wins("p99", summarize(hookOff), summarize(hookOn))).toBe(true);
        expect(wins("fps", summarize(hookOff), summarize(hookOn))).toBe(true);
        expect(wins("fps", summarize(hookOff.slice(0, 1)), summarize(hookOn))).toBe(false);
    });
});

describe("the trade below the target", () => {
    // a two core laptop on 60 Hz (report 2026-10-03): 105 fps with the game's other work waiting 37 ms, at a 60 limit 12 ms
    const uncapped = twice(clean(105, { taskP99: 37, inputP99: 14.7, p99: 15.5, maxMs: 21, stallMs: 0 }));
    const capped = twice(clean(60, { taskP99: 12.5, inputP99: 22, p99: 21.6, maxMs: 23, stallMs: 0 }));

    test("a limit that makes the game react much sooner may make the mouse wait a little longer", () => {
        expect(accept(uncapped, capped, { capBefore: 0, capAfter: 60 }).failed).toBe("inputP99");
        const traded = accept(uncapped, capped, { capBefore: 0, capAfter: 60, trade: true });
        expect(traded.keep).toBe(true);
        expect(traded.traded?.task).toBeCloseTo(24.5);
        expect(traded.traded?.input).toBeCloseTo(7.3);
        const choice = chooseCap(new Map([[0, uncapped], [60, capped]]), 0, { inputRequired: true, trade: true });
        expect(choice.winner).toBe(60);
        expect(choice.judged.find((entry) => entry.cap === 60)?.gains?.input).toBeCloseTo(-7.3);
    });

    test("the trade needs a sooner reaction that outweighs the wait, and never buys stutter", () => {
        const little = twice(clean(60, { taskP99: 32, inputP99: 22 }));
        expect(accept(uncapped, little, { capBefore: 0, capAfter: 60, trade: true }).failed).toBe("inputP99");
        expect(chooseCap(new Map([[0, uncapped], [60, little]]), 0, { trade: true }).changed).toBe(false);
        const stalls = capped.map((entry) => ({ ...entry, stallMs: 150 }));
        expect(accept(uncapped, stalls, { capBefore: 0, capAfter: 60, trade: true }).keep).toBe(false);
    });
});

describe("accept", () => {
    const limits = { capBefore: 500, capAfter: 500 };

    test("a result as good as the player's setup is kept", () => {
        expect(accept(twice(clean(500)), twice(clean(500)), limits)).toEqual({ keep: true, failed: null });
    });

    test("no two usable readings of the player's own setup: nothing is kept", () => {
        // release review: two lost-focus readings replaced the baseline, every comparison was unknown and the change stayed
        const lost = twice({ ...clean(200), invalid: true });
        expect(accept(lost, twice(clean(200, { taskP99: 8 })), { capBefore: 200, capAfter: 200 })).toEqual({ keep: false, failed: "reference" });
        expect(accept(twice(clean(200)), lost, { capBefore: 200, capAfter: 200 })).toEqual({ keep: false, failed: "result" });
    });

    test("task delay from 2 to 8 ms is not kept", () => {
        expect(accept(twice(clean(200)), twice(clean(200, { taskP99: 8 })), { capBefore: 200, capAfter: 200 }).failed).toBe("taskP99");
    });

    test("a limiter's jitter below what the clock resolves is no regression", () => {
        // this desktop, simulated collapse: slowest frames 0.55 ms beyond the typical one without a limit, 0.8 at 495
        const before = twice(clean(1250, { p50: 0.8, p99: 1.35, maxMs: 2.5, stallMs: 400, taskP99: 42, inputP99: 31 }));
        const after = twice(clean(495, { p50: 2, p99: 2.8, maxMs: 3.8, taskP99: 1.6, inputP99: 2.5 }));
        expect(accept(before, after, { capBefore: 0, capAfter: 495 }).keep).toBe(true);
    });

    test("a lower limit that makes the mouse wait longer is not kept, whatever chose it", () => {
        // release review: a steady 500 limit became 120 for "room", mouse wait 2.5 to 8.83 ms, hidden by counting from the frame time
        expect(accept(twice(clean(500)), twice(clean(120)), { capBefore: 500, capAfter: 120 }).failed).toBe("inputP99");
    });

    test("without a mouse wait a longer frame counts as one", () => {
        const blind = (/** @type {number} */ fps) => twice(clean(fps, { inputP99: null }));
        expect(accept(blind(500), blind(120), { capBefore: 500, capAfter: 120 }).failed).toBe("frame");
        expect(accept(blind(120), blind(500), { capBefore: 120, capAfter: 500 }).keep).toBe(true);
    });

    test("the same limit with fewer frames is not kept", () => {
        const slow = twice(clean(100, { p99: 2.5, maxMs: 3, inputP99: 2.5 }));
        expect(accept(twice(clean(500)), slow, { capBefore: 0, capAfter: 0 }).failed).toBe("fps");
    });

    test("an unsteady result is only kept when it measurably stalls less than an unsteady start", () => {
        const collapsed = twice(clean(280, { stallMs: 460, taskP99: 70, inputP99: 30, p99: 28, maxMs: 45 }));
        // release review: fps 80 to 60, stalls 600 to 698 ms per second, both unsteady, reported as "Optimized"
        const bad = twice(clean(80, { stallMs: 600, taskP99: 20, inputP99: 5.5, p99: 80, maxMs: 80 }));
        const worse = [clean(63, { stallMs: 400, taskP99: 20, inputP99: 5.5, p99: 100, maxMs: 100 }), clean(58, { stallMs: 995, taskP99: 20, inputP99: 5.5, p99: 500, maxMs: 500 })];
        expect(accept(bad, worse, { capBefore: 0, capAfter: 360 }).failed).toBe("unsteady");
        expect(accept(twice(clean(500)), collapsed, { capBefore: 500, capAfter: 0 }).failed).toBe("unsteady");
        // from a collapse to a limit that holds
        expect(accept(collapsed, twice(clean(330)), { capBefore: 0, capAfter: 330 }).keep).toBe(true);
    });
});

describe("screen", () => {
    const base = summarize(hookOn);

    test("one clearly better reading is worth a second one", () => {
        expect(screen(hookOff[0], base)).toBe("contender");
    });

    test("a lag regression is out after one reading, whatever the fps", () => {
        expect(screen(reading({ fps: 2000, p99: 1.0, taskP99: 11 }), base)).toBe("worse");
    });

    test("inside the incumbent's own spread nothing is said", () => {
        expect(screen(reading({ fps: 704, p99: 2.05, taskP99: 2.35 }), base)).toBe("same");
        expect(screen(reading({ fps: 2000, invalid: true }), base)).toBe("same");
    });
});

describe("compare", () => {
    test("a repeatable but tiny difference is the same", () => {
        const a = summarize([reading({ p99: 2.00 }), reading({ p99: 2.00 })]);
        const b = summarize([reading({ p99: 2.10 }), reading({ p99: 2.10 })]);
        expect(compare("p99", a, b)).toBe("same");
    });

    test("a difference inside the spread is the same", () => {
        const a = summarize([reading({ p99: 2.0 }), reading({ p99: 4.0 })]);
        const b = summarize([reading({ p99: 3.5 }), reading({ p99: 3.6 })]);
        expect(compare("p99", a, b)).toBe("same");
    });
});

// the same laptop on 2026-10-01 with the hook off, in the test match: clean at its own 515 limit, and without a limit
// slower than with one, standing still a third to half of the time. 543 was read right after "no limit" each round
describe("a PC that collapses when pushed", () => {
    const at515 = [reading({ fps: 512, p50: 2.0, p99: 3.9, maxMs: 5.8, stallMs: 0, taskP99: 4.2, inputP99: 3.6 }), reading({ fps: 511, p50: 2.0, p99: 4.0, maxMs: 6.2, stallMs: 0, taskP99: 5.2, inputP99: 3.7 })];
    const at495 = [reading({ fps: 494, p50: 2.0, p99: 3.9, maxMs: 5.1, stallMs: 0, taskP99: 4.4, inputP99: 3.7 }), reading({ fps: 495, p50: 2.0, p99: 4.0, maxMs: 5.4, stallMs: 0, taskP99: 5.7, inputP99: 3.9 })];
    const at543 = [reading({ fps: 541, p50: 2.0, p99: 4.0, maxMs: 5.9, stallMs: 0, taskP99: 4.5, inputP99: 3.4 }), reading({ fps: 260, p50: 2.0, p99: 31.8, maxMs: 49.1, stallMs: 637, taskP99: 97.4, inputP99: 30.3 })];
    const noLimit = [reading({ fps: 330, p50: 3.1, p99: 28.2, maxMs: 45.4, stallMs: 336, taskP99: 48.2, inputP99: 28.8 }), reading({ fps: 232, p50: 3.2, p99: 33.7, maxMs: 50.5, stallMs: 587, taskP99: 93.3, inputP99: 36.6 })];
    const match = new Map([[515, at515], [0, noLimit], [543, at543], [495, at495]]);

    test("a third of the time lost is a stall, one hitch is not", () => {
        expect(stalled(noLimit[0])).toBe(true);
        expect(stalled(reading({ stallMs: 33 }))).toBe(false);
        expect(stalled(reading({ stallMs: null }))).toBe(false);
    });

    test("one good and one collapsed reading is not steady, and never the better limit", () => {
        expect(steady(at543, 543)).toBe(false);
        const choice = chooseCap(match, 515, { prefer: 495 });
        expect(choice.judged.find((entry) => entry.cap === 543)?.outcome).toBe("not steady");
        expect(choice.judged.find((entry) => entry.cap === 0)?.outcome).toBe("not steady");
        expect(choice.winner).not.toBe(543);
    });

    test("two frame times the clock cannot tell apart are no gain", () => {
        const twin = [reading({ ...at515[0], p50: 1.9999999403953552 }), reading({ ...at515[1], p50: 1.9999999403953552 })];
        const choice = chooseCap(new Map([[515, at515], [530, twin.map((entry) => ({ ...entry, fps: 529 }))]]), 515);
        expect(choice.changed).toBe(false);
    });

    test("the preferred limit takes over by its number, not by a frame time the clock rounds", () => {
        const choice = chooseCap(new Map([[515, at515], [495, at495]]), 515, { prefer: 495 });
        expect(choice.winner).toBe(495);
        expect(choice.decidedBy).toBe("tie");
    });

    test("the PC is known by two stalled readings of one setup", () => {
        expect(collapses(match)).toBe(true);
        expect(collapses(new Map([[515, at515], [543, at543]]))).toBe(false);
        expect(collapses(new Map([[0, [reading({ fps: 2800, stallMs: 2 }), reading({ fps: 2790, stallMs: 33 })]]]))).toBe(false);
    });

    test("the limit is the highest refresh step whose next step still ran steadily", () => {
        expect(steadyRungs(165)).toEqual([165, 330, 495, 660]);
        const held = (/** @type {number} */ cap) => [reading({ fps: cap - 1, stallMs: 0 }), reading({ fps: cap - 2, stallMs: 0 })];
        const missed = (/** @type {number} */ cap) => [reading({ fps: cap * 0.6, stallMs: 410 }), reading({ fps: cap - 1, stallMs: 0 })];
        // steady up to 495, not at 660: 330 has a step of room
        const low = /** @type {[number, ReturnType<typeof held>]} */ ([165, held(165)]);
        expect(steadyLimit(165, new Map([low, [330, held(330)], [495, held(495)], [660, missed(660)]]))).toEqual({ cap: 330, steadyUpTo: 495 });
        // the step above the target ran too: the target
        expect(steadyLimit(165, new Map([low, [330, held(330)], [495, held(495)], [660, held(660)]]))).toEqual({ cap: 495, steadyUpTo: 660 });
        // only the first step ran: the refresh rate
        expect(steadyLimit(165, new Map([low, [330, held(330)], [495, missed(495)]]))).toEqual({ cap: 165, steadyUpTo: 330 });
        // only the refresh rate itself: it is the limit, without room
        expect(steadyLimit(165, new Map([low, [330, missed(330)]]))).toEqual({ cap: 165, steadyUpTo: 165 });
        // release review: the refresh rate used to be the answer without having run steadily itself
        expect(steadyLimit(165, new Map([[165, missed(165)], [330, held(330)]]))).toEqual({ cap: null, steadyUpTo: null });
        expect(steadyLimit(165, new Map([[330, held(330)]]))).toEqual({ cap: null, steadyUpTo: null });
        // a step that was skipped proves nothing above it
        expect(steadyLimit(165, new Map([low, [330, held(330)], [660, held(660)]]))).toEqual({ cap: 165, steadyUpTo: 330 });
        // a limit the PC does not reach is no room either
        expect(steadyLimit(165, new Map([low, [330, held(330)], [495, [reading({ fps: 420, stallMs: 0 }), reading({ fps: 430, stallMs: 0 })]]]))).toEqual({ cap: 165, steadyUpTo: 330 });
    });
});

describe("clock resolution", () => {
    // an RX 7900 XT at 2700 fps, 2026-10-01: the page clock ticks in 0.1 ms steps and the readings sat one tick apart
    test("two clock steps or less are no difference, however repeatable", () => {
        const uncapped = summarize([reading({ p99: 0.1, taskP99: 1.8 }), reading({ p99: 0.1, taskP99: 1.8 })]);
        const capped = summarize([reading({ p99: 0.3, taskP99: 2.0 }), reading({ p99: 0.3, taskP99: 2.0 })]);
        expect(compare("p99", capped, uncapped)).toBe("same");
        expect(compare("taskP99", capped, uncapped)).toBe("same");
        expect(screen(reading({ p99: 0.3, taskP99: 2.0 }), uncapped)).toBe("same");
    });

    test("more than two steps still counts", () => {
        const uncapped = summarize([reading({ taskP99: 1.8 }), reading({ taskP99: 1.8 })]);
        const capped = summarize([reading({ taskP99: 2.35 }), reading({ taskP99: 2.35 })]);
        expect(compare("taskP99", capped, uncapped)).toBe("worse");
    });

    test("fps has no clock floor", () => {
        const a = summarize([reading({ fps: 1000 }), reading({ fps: 1000 })]);
        const b = summarize([reading({ fps: 1200 }), reading({ fps: 1200 })]);
        expect(compare("fps", b, a)).toBe("better");
    });
});

describe("capacity and targets", () => {
    test("headroom follows the pc's own drift and noise", () => {
        // last / first = 1 means no drift, the old formula made that a headroom of 3
        expect(headroom(1, 0.03)).toBeCloseTo(1.03);
        expect(headroom(0.8, 0.03)).toBeCloseTo(1.4);
        expect(headroom(1.08, 0.07)).toBeCloseTo(1.16);
    });

    test("experience holds within one refresh, unknown does not fail it", () => {
        expect(experienceHolds(summarize([reading({ p99: 2.1, stallMs: 0 })]), 165)).toBe(true);
        expect(experienceHolds(summarize([reading({ p99: 25, stallMs: 0 })]), 165)).toBe(false);
        expect(experienceHolds(summarize([reading({ fps: 829 })]), 165)).toBe(true);
    });
});

describe("caps", () => {
    test("165 Hz with the player's 235 cap", () => {
        expect(capCandidates({ hz: 165, capacity: 829, current: 235 })).toEqual([0, 746, 495, 330, 235, 165]);
    });

    test("a weak pc on a fast screen drops the caps it cannot reach", () => {
        expect(capCandidates({ hz: 240, capacity: 300, current: 0 })).toEqual([0, 270, 240]);
    });

    test("refinement looks between the best cap and its neighbours", () => {
        expect(refineCaps([0, 495, 330, 165], 330, 829, 165)).toEqual([]);
        expect(refineCaps([0, 495, 330, 165], 0, 829, 165)).toEqual([660]);
        // 87 between 60 and 105 on a 60 Hz screen was tried once, it cannot look smooth
        expect(refineCaps([0, 60], 60, 105, 60)).toEqual([]);
        expect(refineCaps([0, 120], 120, 300, 60)).toEqual([240]);
    });
});
