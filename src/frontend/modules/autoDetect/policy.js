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
 * performance.now() in a page that is not cross origin isolated moves in 0.1 ms steps. a time metric is the difference
 * of two such readings, so two values less than two steps apart are the same value: at 2700 fps (0.37 ms frames) cap
 * verdicts hung on 0.15 against 0.25 ms. the instrument's resolution, not a number from a PC
 */
export const CLOCK_MS = 0.1;

/**
 * @typedef {object} Reading one measurement window of one configuration. null = not measured, never a zero
 * @property {number|null} fps
 * @property {number|null} [p50] typical frame interval, ms. what `relative` and an fps limit's cost are measured from
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
 * @param {Metric} metric
 * @return {number} the smallest difference the page clock can show in this metric, 0 for a rate
 */
function floorOf(metric){
    return metric === "fps" ? 0 : 2 * CLOCK_MS;
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
    const noise = Math.max(a.spread, b.spread, floorOf(metric));
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
        if (Math.abs(gain) <= Math.max(base.spread, floorOf(metric)) || Math.abs(gain) < important) continue;
        if (gain < 0 && EXPERIENCE.includes(metric)) return "worse";
        if (gain > 0) ahead = true;
    }
    return ahead ? "contender" : "same";
}

/**
 * @typedef {object} Candidate
 * @property {string} id
 * @property {Reading[]} readings
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
 * between setups that run without a limit on the same scene (the client's pipeline): reject every candidate that is
 * worse than the incumbent in an experience metric, then take the one that is better in the earliest experience
 * metric. fps only decides between candidates equal in all of them, and not at all when `fpsCounts` is false.
 * fps limits are chooseCap's business, their frame times cannot be compared like this
 *
 * @param {Candidate} incumbent
 * @param {Candidate[]} candidates
 * @param {{fpsCounts?: boolean}} [options]
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
    const winner = improving[0] ?? null;

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
 * a reading with its time metrics taken from its own typical frame: how much later than usual the slow frames and
 * the mouse come, not how long a frame is. for comparing across fps limits (a cap's frames are longer by design) and
 * across two spawns in the match (another view costs another frame time). fps is dropped, it is neither comparable
 *
 * @param {Reading} reading
 * @return {Reading}
 */
export function relative(reading){
    const base = reading.p50;
    const beyond = (/** @type {number|null} */ value) => (typeof value === "number" && typeof base === "number" ? Math.max(0, value - base) : null);
    return { ...reading, fps: null, p99: beyond(reading.p99), maxMs: beyond(reading.maxMs), inputP99: beyond(reading.inputP99) };
}

/** what a lower fps limit can buy, each in ms beyond the limit's own frame time */
const CAP_GAINS = /** @type {Metric[]} */ (["taskP99", "inputP99", "p99"]);

/**
 * @typedef {object} CapJudged
 * @property {number} cap 0 = no limit
 * @property {Summary} summary of the relative readings
 * @property {number|null} frameMs typical frame time at this limit
 * @property {number|null} netMs delay it removes minus frame time it adds against the limit in use, null: not judged
 * @property {"yours"|"better"|"not better"|"worse"} outcome
 */

/**
 * @typedef {object} CapChoice
 * @property {number} winner the limit in use when nothing beats it
 * @property {boolean} changed
 * @property {"net"|"tie"|null} decidedBy net: removes more delay than it adds frame time. tie: the preferred limit, measured equal
 * @property {CapJudged[]} judged every limit, the one in use included
 */

/**
 * which fps limit. a lower limit makes every frame longer, that is its price in ms, and it pays with what it removes:
 * main thread task delay, mouse wait and frame jitter, each beyond the limit's own frame time. a limit wins when it
 * removes more than it adds, and never when it stalls more. only differences beyond the readings' own spread count
 *
 * @param {Map<number, Reading[]>} readings per limit, 0 = none
 * @param {number} incumbent the limit in use
 * @param {{prefer?: number}} [options] prefer: a limit that takes over when it measures equal and draws fewer frames
 *     (laptops: the target rate instead of everything the PC can do)
 * @return {CapChoice}
 */
export function chooseCap(readings, incumbent, options = {}){
    const summaryOf = (/** @type {number} */ cap) => summarize((readings.get(cap) ?? []).map(relative));
    const frameOf = (/** @type {number} */ cap) => {
        const frames = (readings.get(cap) ?? []).filter((reading) => !reading.invalid).map((reading) => reading.p50).filter((value) => typeof value === "number");
        return frames.length > 0 ? median(/** @type {number[]} */ (frames)) : null;
    };
    const base = summaryOf(incumbent);
    const baseFrame = frameOf(incumbent);

    /** @type {Map<number, number>} confident experience gain in ms, for the tie */
    const gains = new Map();
    /** @type {CapJudged[]} */
    const judged = [...readings.keys()].map((cap) => {
        const summary = summaryOf(cap);
        const frameMs = frameOf(cap);
        if (cap === incumbent) return { cap, summary, frameMs, netMs: null, outcome: /** @type {const} */ ("yours") };
        const verdicts = CAP_GAINS.map((metric) => compare(metric, summary, base));
        if (frameMs === null || baseFrame === null || verdicts.every((verdict) => verdict === "unknown")){
            return { cap, summary, frameMs, netMs: null, outcome: /** @type {const} */ ("not better") };
        }
        let gain = 0;
        for (const [index, metric] of CAP_GAINS.entries()){
            if (verdicts[index] === "better" || verdicts[index] === "worse") gain += (base[metric].median ?? 0) - (summary[metric].median ?? 0);
        }
        gains.set(cap, gain);
        const netMs = gain - (frameMs - baseFrame);
        /** @type {CapJudged["outcome"]} */
        let outcome = "not better";
        if (compare("stallMs", summary, base) === "worse" || gain < 0) outcome = "worse";
        else if (netMs > 0) outcome = "better";
        return { cap, summary, frameMs, netMs, outcome };
    });

    const better = judged.filter((entry) => entry.outcome === "better").sort((a, b) => (b.netMs ?? 0) - (a.netMs ?? 0));
    if (better.length > 0) return { winner: better[0].cap, changed: true, decidedBy: "net", judged };

    // measured equal: the preferred limit takes over when it draws fewer frames than what runs now
    const preferred = judged.find((entry) => entry.cap === options.prefer && entry.cap !== incumbent);
    if (preferred && preferred.outcome === "not better" && preferred.netMs !== null && gains.get(preferred.cap) === 0 &&
        preferred.frameMs !== null && baseFrame !== null && preferred.frameMs > baseFrame){
        return { winner: preferred.cap, changed: true, decidedBy: "tie", judged };
    }
    return { winner: incumbent, changed: false, decidedBy: null, judged };
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
