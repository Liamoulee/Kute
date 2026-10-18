import { esc, money } from "./presentation.js";

/**
 * @typedef {{t:number,values:(number|null)[],volume?:number|null,ask?:{open:number,high:number,low:number,close:number,samples:number}|null}} ChartPoint
 * @typedef {{label:string,color:string}} Series
 */

export default class MarketChart {
    /** @param {HTMLElement} host @param {ChartPoint[]} points @param {Series[]} series @param {{candles?:boolean,volume?:boolean,zoom?:number,stepMs?:number,offset?:number}} [options] */
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
        const last = points.at(-1)?.t ?? first;
        const duration = last - first || 86_400_000;
        const x = (/** @type {number} */ t) => left + (t - first) / duration * (right - left);
        const y = (/** @type {number} */ v) => bottom - (v - low) / (high - low) * (bottom - top);
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
            svg += points.filter((p) => p.volume !== null && p.volume !== undefined).map((p) => `<rect x="${x(p.t) - barWidth / 2}" y="${244 - (p.volume ?? 0) / volumeMax * 30}" width="${barWidth}" height="${(p.volume ?? 0) / volumeMax * 30}" fill="#f36eaa" opacity=".23"/>`).join("");
        }
        if (candles){
            const bw = Math.max(2, Math.min(12, (right - left) / points.length * 0.65));
            for (const p of points){
                const q = p.ask;
                if (!q) continue;
                const color = q.close >= q.open ? "#71d9b0" : "#f68c9b";
                svg += `<line x1="${x(p.t)}" x2="${x(p.t)}" y1="${y(q.high)}" y2="${y(q.low)}" stroke="${color}"/><rect x="${x(p.t) - bw / 2}" y="${Math.min(y(q.open), y(q.close))}" width="${bw}" height="${Math.max(2, Math.abs(y(q.open) - y(q.close)))}" fill="${color}"/>`;
            }
        }
        {
            const step = options.stepMs ?? 86_400_000;
            for (const [index, s] of series.entries()){
                if (candles && index === 0) continue;
                let path = "";
                let previous = 0;
                for (const p of points){
                    const v = p.values[index];
                    if (v === null || v === undefined || !Number.isFinite(v)){
                        previous = 0;
                        continue;
                    }
                    path += `${previous && p.t - previous <= step * 1.5 ? "L" : "M"}${x(p.t)},${y(v)} `;
                    previous = p.t;
                    svg += `<circle cx="${x(p.t)}" cy="${y(v)}" r="${points.length < 3 ? 3 : 1.5}" fill="${s.color}"/>`;
                }
                svg += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
            }
        }
        host.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(candles ? "Sampled asking-price candles" : series.map((s) => s.label).join(", "))}">${svg}<line class="crosshair" x1="0" x2="0" y1="${top}" y2="244" stroke="#858796" stroke-dasharray="3 4" visibility="hidden"/></svg><div class="chartTooltip" hidden></div>`;
        const graph = /** @type {SVGSVGElement} */ (host.querySelector("svg"));
        const tooltip = /** @type {HTMLDivElement} */ (host.querySelector(".chartTooltip"));
        const crosshair = /** @type {SVGLineElement} */ (host.querySelector(".crosshair"));
        graph.addEventListener("pointermove", (event) => {
            const bounds = graph.getBoundingClientRect();
            const px = (event.clientX - bounds.left) * w / bounds.width;
            const t = first + (px - left) / (right - left) * duration;
            const point = points.reduce((best, p) => Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best);
            const q = point.ask;
            let details = series.map((s, i) => `${esc(s.label)} <b>${money(point.values[i])}</b>`).join("<br>");
            if (candles) details = q ? `Open ${money(q.open)} &middot; High ${money(q.high)}<br>Low ${money(q.low)} &middot; Close ${money(q.close)}<br>${q.samples} sampled quote${q.samples === 1 ? "" : "s"}` : "No quote in this bucket";
            if (candles && series.length > 1) details += "<br>" + series.slice(1).map((s, i) => `${esc(s.label)} <b>${money(point.values[i + 1])}</b>`).join("<br>");
            tooltip.innerHTML = `<strong>${esc(new Date(point.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }))} UTC</strong><br>${details}${options.volume && point.volume !== null && point.volume !== undefined ? `<br>Sales ${point.volume}` : ""}`;
            tooltip.hidden = false;
            tooltip.style.left = `${Math.max(0, Math.min(px + 14, w - 240))}px`;
            crosshair.setAttribute("x1", String(x(point.t)));
            crosshair.setAttribute("x2", String(x(point.t)));
            crosshair.setAttribute("visibility", "visible");
        });
        graph.addEventListener("pointerleave", () => {
            tooltip.hidden = true;
            crosshair.setAttribute("visibility", "hidden");
        });
    }
}
