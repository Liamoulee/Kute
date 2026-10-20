import { esc, money } from "./presentation.js";
import { lineSegments } from "./chartData.js";

/**
 * @typedef {{t:number,end?:number,partial?:boolean,values:(number|null)[],volume?:number|null,ask?:{open:number,high:number,low:number,close:number,samples:number}|null}} ChartPoint
 * @typedef {{label:string,color:string}} Series
 * @typedef {{candles?:boolean,volume?:boolean,zoom?:number,stepMs?:number,offset?:number,connectGaps?:boolean}} ChartOptions
 */

export default class MarketChart {
    /** @param {HTMLElement} host @param {ChartPoint[]} points @param {Series[]} series @param {ChartOptions} [options] */
    constructor(host, points, series, options = {}){
        this.host = host;
        this.points = points;
        this.series = series;
        this.options = options;
        this.observer = new ResizeObserver((entries) => this.draw(entries[0]?.contentRect.width ?? 700));
        this.observer.observe(host);
        this.draw(host.clientWidth || 700);
    }

    destroy(){
        this.observer.disconnect();
        this.host.replaceChildren();
    }

    /** @param {number} width */
    draw(width){
        const { host, series, options } = this;
        const count = Math.max(8, Math.ceil(this.points.length / (options.zoom ?? 1)));
        const end = Math.max(Math.min(count, this.points.length), this.points.length - (options.offset ?? 0));
        const points = this.points.slice(Math.max(0, end - count), end);
        const candles = !!options.candles;
        const values = points.flatMap((p) => {
            if (!candles) return p.values;
            return [...(p.ask ? [p.ask.low, p.ask.high] : []), ...p.values.slice(1)];
        }).flatMap((v) => v !== null && Number.isFinite(v) ? [v] : []);
        if (!values.length){
            host.innerHTML = `<div class="chartEmpty">${candles ? "No sampled asking-price candles in this period. Try a longer range or switch to the line chart." : "No price observations in this period. Try a longer range."}</div>`;
            return;
        }
        const w = Math.max(280, width);
        const h = 270;
        const left = 62;
        const right = w - 16;
        const top = 20;
        const bottom = options.volume ? 196 : 230;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const span = max - min || Math.max(1, max * 0.1);
        const low = Math.max(0, min - span * 0.12);
        const high = max + span * 0.12;
        const first = points[0].t;
        const last = (candles ? points.at(-1)?.end : points.at(-1)?.t) ?? first;
        const duration = last - first || 86_400_000;
        const x = (/** @type {number} */ t) => left + (t - first) / duration * (right - left);
        const y = (/** @type {number} */ v) => bottom - (v - low) / (high - low) * (bottom - top);
        const at = (/** @type {ChartPoint} */ point) => candles && point.end ? (point.t + point.end) / 2 : point.t;
        const step = options.stepMs ?? 86_400_000;
        const segments = series.map((s, index) => lineSegments(points, index, step));
        let svg = "";
        for (let i = 0; i <= 4; i++){
            const value = low + (high - low) * i / 4;
            const label = high - low < 10 ? value.toFixed(2) : money(value);
            svg += `<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="#292b35"/><text x="${left - 10}" y="${y(value) + 4}" text-anchor="end">${esc(label)}</text>`;
        }
        for (let i = 0; i <= 4; i++){
            const t = first + duration * i / 4;
            const date = new Date(t);
            const label = duration <= 2 * 86_400_000 ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : date.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
            let anchor = "middle";
            if (i === 0) anchor = "start";
            if (i === 4) anchor = "end";
            svg += `<text x="${x(t)}" y="260" text-anchor="${anchor}">${esc(label)}</text>`;
        }
        if (options.volume){
            const volumeMax = Math.max(1, ...points.map((p) => p.volume ?? 0));
            const barWidth = Math.max(1, Math.min(14, (right - left) / Math.max(1, points.length) * 0.6));
            svg += points.filter((p) => p.volume !== null && p.volume !== undefined).map((p) => `<rect x="${x(at(p)) - barWidth / 2}" y="${244 - (p.volume ?? 0) / volumeMax * 30}" width="${barWidth}" height="${(p.volume ?? 0) / volumeMax * 30}" fill="#f36eaa" opacity=".23"/>`).join("");
        }
        if (candles){
            const bw = Math.max(3, Math.min(14, (right - left) * step / duration * 0.65));
            for (const p of points){
                const q = p.ask;
                if (!q) continue;
                let direction = "flat";
                let color = "#9698a7";
                if (q.samples <= 1) direction = "single";
                else if (q.close !== q.open){
                    direction = q.close > q.open ? "up" : "down";
                    color = q.close > q.open ? "#71d9b0" : "#f68c9b";
                }
                const cx = x(at(p));
                svg += `<g data-candle="${direction}">`;
                if (q.samples > 1) svg += `<line x1="${cx}" x2="${cx}" y1="${y(q.high)}" y2="${y(q.low)}" stroke="${color}"/>`;
                if (direction === "single" || direction === "flat") svg += `<line x1="${cx - bw / 2}" x2="${cx + bw / 2}" y1="${y(q.close)}" y2="${y(q.close)}" stroke="${color}" stroke-width="2"/>`;
                else svg += `<rect x="${cx - bw / 2}" y="${Math.min(y(q.open), y(q.close))}" width="${bw}" height="${Math.max(2, Math.abs(y(q.open) - y(q.close)))}" fill="${color}"/>`;
                svg += "</g>";
            }
        }
        for (const [index, s] of series.entries()){
            if (candles && index === 0) continue;
            let path = "";
            let gaps = "";
            for (const segment of segments[index]){
                const line = `M${x(at(segment.from))},${y(/** @type {number} */(segment.from.values[index]))} L${x(at(segment.to))},${y(/** @type {number} */(segment.to.values[index]))} `;
                if (!segment.gap) path += line;
                else if (options.connectGaps) gaps += line;
            }
            for (const p of points){
                const v = p.values[index];
                if (v === null || v === undefined || !Number.isFinite(v)){
                    continue;
                }
                svg += `<circle cx="${x(at(p))}" cy="${y(v)}" r="${points.length < 20 ? 3 : 1.5}" fill="${s.color}"/>`;
            }
            svg += `<path class="observedLine" d="${path}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
            if (gaps) svg += `<path class="gapLine" d="${gaps}" fill="none" stroke="${s.color}" stroke-width="1.6" stroke-dasharray="5 5" opacity=".65"/>`;
        }
        host.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(candles ? "Sampled asking-price candles" : series.map((s) => s.label).join(", "))}">${svg}<line class="crosshair" x1="0" x2="0" y1="${top}" y2="244" stroke="#858796" stroke-dasharray="3 4" visibility="hidden"/></svg><div class="chartTooltip" hidden></div>`;
        const graph = /** @type {SVGSVGElement} */ (host.querySelector("svg"));
        const tooltip = /** @type {HTMLDivElement} */ (host.querySelector(".chartTooltip"));
        const crosshair = /** @type {SVGLineElement} */ (host.querySelector(".crosshair"));
        graph.addEventListener("pointermove", (event) => {
            const bounds = graph.getBoundingClientRect();
            const px = (event.clientX - bounds.left) * w / bounds.width;
            const t = first + (px - left) / (right - left) * duration;
            const point = points.find(p => candles && p.end && t >= p.t && t < p.end)
                ?? points.reduce((best, p) => Math.abs(at(p) - t) < Math.abs(at(best) - t) ? p : best);
            const gap = !candles && options.connectGaps ? segments[0]?.find(s => s.gap && x(s.from.t) + 5 < px && px < x(s.to.t) - 5) : null;
            const emptyInterval = candles && point.end !== undefined && (t < point.t || t >= point.end);
            const q = point.ask;
            let details = series.map((s, i) => `${esc(s.label)} <b>${money(point.values[i])}</b>`).join("<br>");
            if (candles){
                details = "No quote in this bucket";
                if (q?.samples === 1 && !emptyInterval) details = `Observed ask <b>${money(q.close)}</b><br>1 sampled quote; direction unknown`;
                else if (q && !emptyInterval) details = `Open ${money(q.open)} &middot; High ${money(q.high)}<br>Low ${money(q.low)} &middot; Close ${money(q.close)}<br>${esc(q.samples)} sampled quotes`;
                if (point.partial && !emptyInterval) details += "<br>Partial interval";
            }
            if (candles && !emptyInterval && series.length > 1) details += "<br>Last observed in interval:<br>" + series.slice(1).map((s, i) => `${esc(s.label)} <b>${money(point.values[i + 1])}</b>`).join("<br>");
            if (gap) details = "No price observation in this gap.<br>Dashed line connects recorded values.";
            const dateLabel = (/** @type {number} */ time) => new Date(time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
            let date = dateLabel(gap || emptyInterval ? t : point.t);
            if (candles && point.end && !emptyInterval) date = `${dateLabel(point.t)} to ${dateLabel(point.end)}`;
            tooltip.innerHTML = `<strong>${esc(date)} UTC</strong><br>${details}${!gap && !emptyInterval && options.volume && point.volume !== null && point.volume !== undefined ? `<br>Reported sales ${point.volume}` : ""}`;
            tooltip.hidden = false;
            tooltip.style.left = `${Math.max(0, Math.min(px + 14, w - 240))}px`;
            crosshair.setAttribute("x1", String(gap || emptyInterval ? px : x(at(point))));
            crosshair.setAttribute("x2", String(gap || emptyInterval ? px : x(at(point))));
            crosshair.setAttribute("visibility", "visible");
        });
        graph.addEventListener("pointerleave", () => {
            tooltip.hidden = true;
            crosshair.setAttribute("visibility", "hidden");
        });
    }
}
