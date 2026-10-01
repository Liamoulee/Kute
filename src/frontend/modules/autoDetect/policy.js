/**
 * Which of several measured configurations to use. Pure, no DOM, no clock.
 *
 * No number in here comes from anyone's PC: differences are judged against the spread of the readings themselves
 * and against the configuration's own values, targets come from the display.
 */

/** a difference under this share of the larger value is not worth a change, however repeatable it is */
export const IMPORTANT_SHARE = 0.1;
export const TARGET_REFRESH_MULTIPLE = 3;

/**
 * @typedef {object} Reading one measurement window of one configuration. null = not measured, never a zero
 * @property {number|null} fps
 * @property {number|null} p99 frame interval, ms
 * @property {number|null} maxMs longest frame interval
 * @property {number|null} stallMs ms per second spent in frames over the hitch threshold
 * @property {number|null} taskP99 main thread task delay, ms
 * @property {number|null} inputP99 pointer event wait, ms
 * @property {boolean} [invalid] focus lost, still loading, left the room: the window says nothing
 */

/**
 * @typedef {"fps"|"p99"|"maxMs"|"stallMs"|"taskP99"|"inputP99"} Metric
 */

/**
 * @typedef {object} MetricSummary
 * @property {number} n usable readings
 * @property {number|null} median
 * @property {number|null} spread max - min, null with fewer than two readings
 */

/**
 * @typedef {Record<Metric, MetricSummary>} Summary
 */

/**
 * @typedef {"better"|"worse"|"same"|"unknown"} Verdict
 */

/** what a player feels as lag and stutter, most direct first. a candidate may not get worse in any of them */
export const EXPERIENCE = /** @type {Metric[]} */ (["taskP99", "inputP99", "p99", "stallMs", "maxMs"]);
/** @type {Metric[]} */
const ALL_METRICS = [...EXPERIENCE, "fps"];
/** @type {Set<Metric>} */
const HIGHER_IS_BETTER = new Set(["fps"]);

/**
 * @param {number[]} values
 * @return {number}
 */
function median(values){
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * @param {Reading[]} readings
 * @return {Summary}
 */
export function summarize(readings){
    const usable = readings.filter((reading) => !reading.invalid);
    const summary = /** @type {Summary} */ ({});
    for (const metric of ALL_METRICS){
        const values = usable.map((reading) => reading[metric]).filter((value) => typeof value === "number" && Number.isFinite(value));
        const known = /** @type {number[]} */ (values);
        summary[metric] = {
            n: known.length,
            median: known.length > 0 ? median(known) : null,
            spread: known.length > 1 ? Math.max(...known) - Math.min(...known) : null,
        };
    }
    return summary;
}

/**
 * candidate against incumbent on one metric. a verdict needs two readings on each side: one reading has no spread
 * to judge a difference against
 *
 * @param {Metric} metric
 * @param {Summary} candidate
 * @param {Summary} incumbent
 * @return {Verdict}
 */
export function compare(metric, candidate, incumbent){
    const a = candidate[metric];
    const b = incumbent[metric];
    if (a.median === null || b.median === null || a.spread === null || b.spread === null) return "unknown";
    const gain = HIGHER_IS_BETTER.has(metric) ? a.median - b.median : b.median - a.median;
    const noise = Math.max(a.spread, b.spread);
    const important = Math.max(Math.abs(a.median), Math.abs(b.median)) * IMPORTANT_SHARE;
    if (Math.abs(gain) <= noise || Math.abs(gain) < important) return "same";
    return gain > 0 ? "better" : "worse";
}

/**
 * one reading of a candidate against the incumbent's readings: is it worth a second reading? only the incumbent's
 * spread is known here, so this screens, it never decides
 *
 * @param {Reading} reading
 * @param {Summary} incumbent needs two readings per metric to say anything
 * @return {"contender"|"worse"|"same"} worse: behind in an experience metric. contender: ahead somewhere and not worse
 */
export function screen(reading, incumbent){
    if (reading.invalid) return "same";
    let ahead = false;
    for (const metric of ALL_METRICS){
        const value = reading[metric];
        const base = incumbent[metric];
        if (typeof value !== "number" || base.median === null || base.spread === null) continue;
        const gain = HIGHER_IS_BETTER.has(metric) ? value - base.median : base.median - value;
        const important = Math.max(Math.abs(value), Math.abs(base.median)) * IMPORTANT_SHARE;
        if (Math.abs(gain) <= base.spread || Math.abs(gain) < important) continue;
        if (gain < 0 && EXPERIENCE.includes(metric)) return "worse";
        if (gain > 0) ahead = true;
    }
    return ahead ? "contender" : "same";
}

/**
 * @typedef {object} Candidate
 * @property {string} id
 * @property {Reading[]} readings
 * @property {number} [frames] how many frames it produces, for the tie break (a cap, or the measured fps)
 */

/**
 * @typedef {object} Judged
 * @property {string} id
 * @property {Summary} summary
 * @property {Partial<Record<Metric, Verdict>>} verdicts against the incumbent
 * @property {boolean} rejected a regression in an experience metric
 * @property {Metric|null} decidedBy first experience metric it is better in, "fps" when only that, null when nothing
 */

/**
 * @typedef {object} Choice
 * @property {string} winner the incumbent's id when nothing beats it
 * @property {boolean} changed
 * @property {boolean} inconclusive no candidate could be judged at all (too few readings)
 * @property {Metric|null} decidedBy
 * @property {Summary} incumbent
 * @property {Judged[]} judged
 */

/**
 * reject every candidate that is worse than the incumbent in an experience metric, then take the one that is
 * better in the earliest experience metric. fps only decides between candidates equal in all of them, and only when
 * `fpsCounts` (comparing caps, more frames is not a goal)
 *
 * @param {Candidate} incumbent
 * @param {Candidate[]} candidates
 * @param {{fpsCounts?: boolean, fewerFramesWinTies?: boolean}} [options] fewerFramesWinTies: laptops and hybrid graphics
 * @return {Choice}
 */
export function choose(incumbent, candidates, options = {}){
    const base = summarize(incumbent.readings);
    /** @type {Judged[]} */
    const judged = candidates.map((candidate) => {
        const summary = summarize(candidate.readings);
        /** @type {Partial<Record<Metric, Verdict>>} */
        const verdicts = {};
        for (const metric of ALL_METRICS) verdicts[metric] = compare(metric, summary, base);
        const rejected = EXPERIENCE.some((metric) => verdicts[metric] === "worse");
        /** @type {Metric|null} */
        let decidedBy = EXPERIENCE.find((metric) => verdicts[metric] === "better") ?? null;
        if (decidedBy === null && options.fpsCounts !== false && verdicts.fps === "better") decidedBy = "fps";
        return { id: candidate.id, summary, verdicts, rejected, decidedBy };
    });

    const inconclusive = judged.length > 0 && judged.every((entry) => ALL_METRICS.every((metric) => entry.verdicts[metric] === "unknown"));
    const rank = (/** @type {Judged} */ entry) => (entry.decidedBy === null ? ALL_METRICS.length : ALL_METRICS.indexOf(entry.decidedBy));
    const improving = judged.filter((entry) => !entry.rejected && entry.decidedBy !== null).sort((a, b) => rank(a) - rank(b));
    let winner = improving[0] ?? null;

    // nothing measurably better: on a laptop the candidate that makes fewer frames wins among the equal ones
    if (winner === null && options.fewerFramesWinTies){
        const frames = (/** @type {string} */ id) => [incumbent, ...candidates].find((candidate) => candidate.id === id)?.frames ?? Infinity;
        // equal in what was measured: nothing better or worse, and at least one metric really compared
        const equal = judged.filter(
            (entry) => EXPERIENCE.every((metric) => entry.verdicts[metric] === "same" || entry.verdicts[metric] === "unknown") &&
                EXPERIENCE.some((metric) => entry.verdicts[metric] === "same"),
        );
        const fewest = equal.sort((a, b) => frames(a.id) - frames(b.id))[0];
        if (fewest && frames(fewest.id) < frames(incumbent.id)) winner = fewest;
    }

    return {
        winner: winner?.id ?? incumbent.id,
        changed: winner !== null,
        inconclusive,
        decidedBy: winner?.decidedBy ?? null,
        incumbent: base,
        judged,
    };
}

/**
 * margin over the target: the PC's own slowdown during the run (warmup, heat) doubled, at least its own noise.
 * drift is last / first baseline as the report stores it, 1 = no drift
 *
 * @param {number} drift
 * @param {number} noise spread of repeated samples as a share, 0.03 = 3 %
 * @return {number}
 */
export function headroom(drift, noise){
    return 1 + Math.max(2 * Math.abs(1 - drift), noise);
}

/**
 * frames arrive within one refresh and nothing stalls for a frame's worth per second. unknown readings do not fail it
 *
 * @param {Summary} summary
 * @param {number} hz
 * @return {boolean}
 */
export function experienceHolds(summary, hz){
    const refreshMs = 1000 / hz;
    const p99 = summary.p99.median;
    const stall = summary.stallMs.median;
    return (p99 === null || p99 <= refreshMs) && (stall === null || stall <= refreshMs);
}

/**
 * caps worth measuring, highest first, 0 = uncapped. multiples of the refresh rate the PC can reach, the player's own
 * cap, and a notch under what the PC reaches (the classic cure for a GPU that cannot keep up)
 *
 * @param {{hz: number, capacity: number|null, current: number}} facts
 * @return {number[]}
 */
export function capCandidates({ hz, capacity, current }){
    const reachable = (/** @type {number} */ cap) => capacity === null || cap <= capacity;
    const caps = [TARGET_REFRESH_MULTIPLE * hz, 2 * hz, hz].filter(reachable);
    if (capacity !== null) caps.push(Math.round(capacity * 0.9));
    if (current > 0) caps.push(current);
    const unique = [...new Set(caps.map((cap) => Math.round(cap)).filter((cap) => cap > 0))].sort((a, b) => b - a);
    return [0, ...unique];
}

/**
 * one more cap between the best and each neighbour that was measured, for the refinement round in the match
 *
 * @param {number[]} measured caps already measured, 0 = uncapped
 * @param {number} best
 * @param {number|null} capacity stands in for "uncapped" as a number
 * @return {number[]}
 */
export function refineCaps(measured, best, capacity){
    const value = (/** @type {number} */ cap) => (cap === 0 ? capacity ?? Infinity : cap);
    const sorted = [...new Set(measured)].sort((a, b) => value(a) - value(b));
    const index = sorted.indexOf(best);
    /** @type {number[]} */
    const between = [];
    for (const neighbour of [sorted[index - 1], sorted[index + 1]]){
        if (neighbour === undefined) continue;
        const middle = (value(best) + value(neighbour)) / 2;
        if (Number.isFinite(middle)) between.push(Math.round(middle));
    }
    return between.filter((cap) => cap > 0 && !measured.includes(cap));
}
