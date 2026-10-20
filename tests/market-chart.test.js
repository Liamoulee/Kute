import { expect, test } from "bun:test";
import { candleSeries, lineSegments } from "../src/frontend/modules/market/chartData.js";
import MarketChart from "../src/frontend/modules/market/chart.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const point = (t, price, samples = 1) => ({ t, values: [price], volume: null, ask: { open: price, high: price, low: price, close: price, samples } });

function render(points, options = {}){
    const listeners = {};
    const tooltip = { style: {}, hidden: true, innerHTML: "" };
    const graph = { addEventListener: (name, callback) => { listeners[name] = callback; }, getBoundingClientRect: () => ({ left: 0, width: 700 }) };
    const host = { innerHTML: "", querySelector: selector => ({ svg: graph, ".chartTooltip": tooltip, ".crosshair": { setAttribute(){} } })[selector] };
    MarketChart.prototype.draw.call({ host, points, options, series: [{ label: "Price", color: "#fff" }] }, 700);
    return { host, tooltip, hover: clientX => listeners.pointermove({ clientX }) };
}

test("sparse lines distinguish missing values and missing dates without adding observations", () => {
    const points = [{ t: 0, values: [100] }, { t: DAY, values: [120] }, { t: 2 * DAY, values: [null] }, { t: 3 * DAY, values: [90] }, { t: 8 * DAY, values: [150] }];
    const before = structuredClone(points);
    expect(lineSegments(points, 0, DAY).map(s => [s.from.t, s.to.t, s.gap])).toEqual([[0, DAY, false], [DAY, 3 * DAY, true], [3 * DAY, 8 * DAY, true]]);
    const chart = render(points, { stepMs: DAY, connectGaps: true });
    expect(chart.host.innerHTML.match(/<circle /g)).toHaveLength(4);
    expect(chart.host.innerHTML).toContain('class="gapLine"');
    expect(chart.host.innerHTML).toContain('stroke-dasharray="5 5"');
    chart.hover(62 + 2 / 8 * 622);
    expect(chart.tooltip.innerHTML).toContain("No price observation in this gap");
    expect(chart.tooltip.innerHTML).not.toContain("<b>");
    expect(points).toEqual(before);
});

test("non-finite observations remain gaps and unrelated charts keep gaps disconnected", () => {
    const points = [{ t: 0, values: [5] }, { t: DAY, values: [NaN] }, { t: 2 * DAY, values: [Infinity] }, { t: 3 * DAY, values: [8] }];
    expect(lineSegments(points, 0, DAY)[0].gap).toBe(true);
    const { host } = render(points);
    expect(host.innerHTML).not.toContain('class="gapLine"');
    expect(host.innerHTML).not.toContain("NaN");
    expect(host.innerHTML).not.toContain("Infinity");
});

test("sparse hourly quotes combine in time order and retain extrema and sample counts", () => {
    const points = [point(6 * HOUR, 90), point(0, 100), point(4 * HOUR, 130), point(2 * HOUR, 120)];
    points[0].ask.low = 80;
    points[0].ask.high = 110;
    points[0].ask.samples = 3;
    const before = structuredClone(points);
    const bars = candleSeries(points, HOUR);
    expect(bars.label).toBe("4h");
    expect(bars.points.map(p => p.ask)).toEqual([
        { open: 100, high: 120, low: 100, close: 120, samples: 2 },
        { open: 130, high: 130, low: 80, close: 90, samples: 4 },
    ]);
    expect(bars.points[1].partial).toBe(true);
    expect(points).toEqual(before);
});

test("daily quotes can form Monday UTC weekly candles without filling a missing week", () => {
    const monday = Date.UTC(2026, 9, 5);
    const points = [point(monday, 100), point(monday + 2 * DAY, 120), point(monday + 14 * DAY, 200), point(monday + 16 * DAY, 180)];
    points[0].volume = 5;
    points[1].volume = 2;
    points[0].values.push(80);
    points[1].values.push(90);
    const bars = candleSeries(points, DAY);
    expect(bars.label).toBe("7D");
    expect(bars.points.map(p => p.t)).toEqual([monday, monday + 14 * DAY]);
    expect(bars.points.map(p => p.volume)).toEqual([7, null]);
    expect(bars.points[0].values[1]).toBe(90);
    expect(bars.points.map(p => p.ask.samples)).toEqual([2, 2]);
    const chart = render(bars.points, { candles: true, stepMs: bars.stepMs });
    chart.hover(62 + 10 / 21 * 622);
    expect(chart.tooltip.innerHTML).toContain("No quote in this bucket");
    expect(chart.tooltip.innerHTML).not.toContain("Open");
});

test("dense quotes retain their interval and sparse quotes never collapse into a single candle", () => {
    expect(candleSeries([point(0, 100, 4), point(HOUR, 110, 4)], HOUR).label).toBe("1h");
    expect(candleSeries([point(0, 100), point(2 * HOUR, 110)], HOUR).points).toHaveLength(2);
    expect(candleSeries([point(0, 100)], HOUR).points[0].ask.samples).toBe(1);
    expect(candleSeries([], DAY).points).toEqual([]);
});

test("candles show rising and falling asks while single and unchanged quotes stay neutral", () => {
    const points = [point(0, 100), point(HOUR, 100, 2), point(2 * HOUR, 100, 3), point(3 * HOUR, 100, 3)];
    points[2].ask.close = 110; points[2].ask.high = 110;
    points[3].ask.close = 90; points[3].ask.low = 90;
    const bars = candleSeries(points, HOUR);
    const chart = render(bars.points, { candles: true, stepMs: HOUR });
    for (const direction of ["up", "down", "single", "flat"]) expect(chart.host.innerHTML).toContain(`data-candle="${direction}"`);
    expect(chart.host.innerHTML.match(/<rect /g)).toHaveLength(2);
    chart.hover(62 + 0.5 / 4 * 622);
    expect(chart.tooltip.innerHTML).toContain("direction unknown");
    expect(chart.tooltip.innerHTML).not.toContain("Open");
});
