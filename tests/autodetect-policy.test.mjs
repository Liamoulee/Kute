import { describe, expect, test } from "bun:test";
import { capacityFps, capCandidates, choose, compare, experienceHolds, headroom, refineCaps, summarize } from "../src/frontend/modules/autoDetect/policy.js";

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

    test("caps: fps does not count, a laptop takes the lower cap among equals", () => {
        const same = () => [reading({ fps: 0, p99: 4.7, taskP99: 1.7 }), reading({ fps: 0, p99: 4.7, taskP99: 1.8 })];
        const incumbent = { id: "0", readings: same(), frames: 800 };
        const candidates = [{ id: "495", readings: same(), frames: 495 }, { id: "330", readings: same(), frames: 330 }];
        expect(choose(incumbent, candidates, { fpsCounts: false }).changed).toBe(false);
        expect(choose(incumbent, candidates, { fpsCounts: false, fewerFramesWinTies: true }).winner).toBe("330");
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

describe("capacity and targets", () => {
    test("a cap is not a weak pc", () => {
        expect(capacityFps(reading({ fps: 235, workMs: 1.2 }), true)).toBeCloseTo(833, 0);
        expect(capacityFps(reading({ fps: 235 }), true)).toBe(null);
        expect(capacityFps(reading({ fps: 829 }), false)).toBe(829);
    });

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
