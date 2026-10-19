const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const INTERVALS = [HOUR, 4 * HOUR, 12 * HOUR, DAY, 7 * DAY];

/** @param {import("./chart.js").ChartPoint[]} points @param {number} index @param {number} step */
export function lineSegments(points, index, step){
    /** @type {{from:import("./chart.js").ChartPoint,to:import("./chart.js").ChartPoint,gap:boolean}[]} */
    const segments = [];
    /** @type {import("./chart.js").ChartPoint|null} */
    let previous = null;
    let missing = false;
    for (const point of points){
        const value = point.values[index];
        if (value === null || value === undefined || !Number.isFinite(value)){
            missing = true;
            continue;
        }
        if (previous) segments.push({ from: previous, to: point, gap: missing || point.t - previous.t > step * 1.5 });
        previous = point;
        missing = false;
    }
    return segments;
}

/** @param {import("./chart.js").ChartPoint[]} points @param {number} step @param {number} baseStep */
function groupCandles(points, step, baseStep){
    /** @type {Map<number,import("./chart.js").ChartPoint>} */
    const grouped = new Map();
    // weekly buckets start on monday UTC
    const offset = step === 7 * DAY ? 4 * DAY : 0;
    for (const point of [...points].sort((a, b) => a.t - b.t)){
        const bucket = Math.floor((point.t - offset) / step) * step + offset;
        let group = grouped.get(bucket);
        if (!group){
            group = { t: bucket, end: bucket + step, values: [], volume: null, ask: null, partial: false };
            grouped.set(bucket, group);
        }
        for (const [index, value] of point.values.entries()){
            if (value !== null && Number.isFinite(value)) group.values[index] = value;
        }
        if (point.volume !== null && point.volume !== undefined && Number.isFinite(point.volume)) group.volume = (group.volume ?? 0) + point.volume;
        const quote = point.ask;
        if (!quote) continue;
        if (!group.ask) group.ask = { ...quote };
        else {
            group.ask.high = Math.max(group.ask.high, quote.high);
            group.ask.low = Math.min(group.ask.low, quote.low);
            group.ask.close = quote.close;
            group.ask.samples += quote.samples;
        }
    }
    const first = Math.min(...points.map(p => p.t));
    const end = Math.max(...points.map(p => p.t + baseStep));
    for (const group of grouped.values()) group.partial = group.t < first || (group.end ?? 0) > end || (group.end ?? 0) > Date.now();
    return [...grouped.values()];
}

/** @param {import("./chart.js").ChartPoint[]} points @param {number} baseStep */
export function candleSeries(points, baseStep){
    let step = baseStep;
    let grouped = groupCandles(points, step, baseStep);
    const quality = (/** @type {import("./chart.js").ChartPoint[]} */ rows) => {
        const quotes = rows.filter(p => p.ask);
        return { count: quotes.length, share: quotes.filter(p => (p.ask?.samples ?? 0) > 1).length / Math.max(1, quotes.length) };
    };
    let best = quality(grouped);
    for (const candidate of INTERVALS.filter(size => size > baseStep)){
        if (best.share >= 0.6 || best.count < 2) break;
        const next = groupCandles(points, candidate, baseStep);
        const score = quality(next);
        // preserve at least two candles instead of collapsing a sparse history into one
        if (score.count < 2 || score.share <= best.share) continue;
        step = candidate;
        grouped = next;
        best = score;
    }
    const label = step >= DAY ? `${step / DAY}D` : `${step / HOUR}h`;
    return { points: grouped, stepMs: step, label };
}
