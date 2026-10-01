import { describe, expect, test } from "bun:test";
import { capCandidates, choose, chooseCap, compare, experienceHolds, headroom, refineCaps, relative, screen, summarize } from "../src/frontend/modules/autoDetect/policy.js";

/**
 * @param {Partial<import("../src/frontend/modules/autoDetect/policy.js").Reading>} values
 * @return {import("../src/frontend/modules/autoDetect/policy.js").Reading}
 */
function reading(values){
    return { fps: null, p99: null, maxMs: null, stallMs: null, taskP99: null, inputP99: null, ...values };
}

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

    test("one reading per cap decides nothing", () => {
        const choice = chooseCap(new Map([[0, at(3.5, 8.15).slice(0, 1)], [180, at(5.55, 2.6).slice(0, 1)]]), 0, { prefer: 180 });
        expect(choice.changed).toBe(false);
        expect(choice.judged.find((entry) => entry.cap === 180)?.netMs).toBe(null);
    });
});

describe("relative", () => {
    test("time metrics count from the reading's own typical frame", () => {
        const result = relative(reading({ fps: 180, p50: 5.5, p99: 6.0, maxMs: 6.5, inputP99: 7.0, taskP99: 2 }));
        expect(result.p99).toBeCloseTo(0.5);
        expect(result.maxMs).toBeCloseTo(1.0);
        expect(result.inputP99).toBeCloseTo(1.5);
        expect(result.taskP99).toBe(2);
        expect(result.fps).toBe(null);
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
        expect(refineCaps([0, 495, 330, 165], 330, 829)).toEqual([248, 413]);
        expect(refineCaps([0, 495, 330, 165], 0, 829)).toEqual([662]);
    });
});
