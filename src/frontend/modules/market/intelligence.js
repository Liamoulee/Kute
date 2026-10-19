import { esc, money, identity, empty } from "./presentation.js";
import { formatAge } from "./types.js";

/**
 * @typedef {{kind:string,tone:string,title:string,detail:string,strength:number}} MarketSignal
 * @typedef {{signals:MarketSignal[],score:number,outlook:{state:string,issuedAt:number|null,start:string|null,end:string|null,point:number|null,low:number|null,high:number|null},asOf:number}} ItemIntelligence
 * @typedef {{samples:number,items:number,weeks:number,modelError:number|null,lastError:number|null,baselineError:number|null,skill:number|null,coverage:number|null,bands:number,width:number|null}} ForecastMetrics
 * @typedef {{items:(import("./types.js").SkinSummary & {intelligence:ItemIntelligence})[],model:{version:string,trainedAt:number,trainingSamples:number,historical:ForecastMetrics,forward:ForecastMetrics,state:string,reason:string}|null,coverage:{items:number,dailyRows:number,firstDay:string|null,lastDay:string|null,supplySince:number|null,contributedSales:number},sources:{source:string,observedAt:number,records:number}[],news:{title:string,url:string|null,observedAt:number}[],asOf:number}} IntelligenceReply
 */

/** @param {number|null} n */
const percent = n => n === null ? "Not available" : `${(n * 100).toFixed(1)}%`;

/** @param {{assessment?:{reasons:string[],risks:string[]}}} deal */
export function dealEvidence(deal){
    const {
        assessment,
    } = deal;
    if (!assessment) return "";
    const text = assessment.risks[0] ?? "Supported by recent sales";
    return `<span
    class="dealEvidence ${assessment.risks.length ? "negative" : "positive"}" title="${esc([...assessment.reasons, ...assessment.risks].join(". "))}">${esc(text)}${assessment.risks.length > 1 ? ` +${assessment.risks.length - 1} risk${assessment.risks.length > 2 ? "s" : ""}` : ""}</span>`;
}

/** @param {ItemIntelligence|undefined} intel @param {boolean} [compact] */
export function itemIntelligence(intel, compact = false){
    if (!intel) return "";
    const {
        outlook,
    } = intel;
    const signals = intel.signals.slice(0, compact ? 2 : 4);
    if (!signals.length && outlook.state !== "published") return "";
    let forecast = "";
    if (outlook.state === "published"){
        forecast = `<div
    class="outlook">
<span
    class="eyebrow">7-DAY REPORTED-PRICE OUTLOOK</span>
<h2>${money(outlook.point)} KR</h2>
<p
    class="sub">90% range: ${money(outlook.low)} to ${money(outlook.high)} KR. ${esc(outlook.start)} through ${esc(outlook.end)}, conditional on reported sales.</p>
</div>`;
    }
    return `<section
    class="panel intelligenceItem">
<div
    class="panelHead">
<h3>Market intelligence</h3>
<button
    class="textButton"
    data-nav="intelligence">Explore signals &#8594;</button>
</div>${signals.length ? signals.map(s => `<div
    class="signalReason">
<b
    class="${esc(s.tone)}">${esc(s.title)}</b>
<p>${esc(s.detail)}</p>
</div>`).join("") : '<p class="sub">No observation to highlight.</p>'}${forecast}</section>`;
}

/** @param {IntelligenceReply} reply @param {string} kind @param {boolean} advanced @param {number[]} watched */
export function intelligenceView(reply, kind, advanced, watched){
    const {
        model,
    } = reply;
    const historical = model?.historical;
    const forward = model?.forward;
    const skill = historical?.skill ?? null;
    const filters = [["", "All signals"], ["activity", "Activity"], ["supply", "Supply"], ["relative", "Relative value"], ["risk", "Risks"], ["availability", "Availability"]];
    const items = [...reply.items].sort((a, b) => Number(watched.includes(b.skin)) - Number(watched.includes(a.skin)));
    const metrics = (/** @type {NonNullable<typeof historical>} */m) => `<td>${money(m.samples)}</td>
<td>${m.weeks}</td>
<td>${m.modelError === null ? "Pending" : m.modelError.toFixed(3)}</td>
<td>${m.skill === null ? "Pending" : percent(m.skill)}</td>
<td>${m.coverage === null ? "Pending" : percent(m.coverage)}</td>`;
    return `<div class="pageIntro">
<div>
<div class="eyebrow">KUTE INTELLIGENCE</div>
<h1>Read the market.</h1>
<p class="sub">Experimental observations of activity, supply and price changes. Predictive usefulness has not been established.</p>
</div>
<button class="button" data-nav="deals">Find potential deals &#8594;</button>
</div>` + `<section
    class="intelligenceHero">
<div>
<span
    class="eyebrow">${model?.state === "published" ? "7-DAY OUTLOOK" : "RESEARCH, NOT PUBLISHED FORECASTS"}</span>
<h2>${model?.state === "published" ? "Forecasts with a measured track record." : "Price forecast research"}</h2>
<p
    class="sub">${model ? `${money(model.trainingSamples)} historical examples train the price model. ${esc(model.reason)}` : "The next model run will train on completed market history. Signals below explain observations already available."}</p>
</div>
<div
    class="intelligenceProof">
<span>Historical error reduction</span>
<strong
    class="${skill !== null && skill > 0 ? "positive" : "muted"}">${skill === null ? "Pending" : percent(skill)}</strong>
<small>vs the better of two baselines<br>${money(historical?.samples ?? 0)} held-out predictions</small>
<span
    class="tag quiet">${money(forward?.samples ?? 0)} forward outcomes</span>
</div>
</section>` + `<div
    class="intelligenceFilters"
    role="group"
    aria-label="Signal type">${filters.map(([value, label]) => `<button
    class="button small ${kind === value ? "primary" : ""}" data-intel-kind="${value}" aria-pressed="${kind === value}">${label}</button>`).join("")}</div>` + (items.length ? `<div
    class="intelligenceGrid">${items.map(s => {
            const signals = s.intelligence.signals.filter(signal => !kind || signal.kind === kind);
            const first = signals[0];
            const second = s.intelligence.signals.find(signal => signal !== first && signal.kind === "risk");
            return `<article
    class="signalCard">
<div
    class="panelHead">
<button
    data-skin="${esc(s.skin)}">${identity(s)}</button>${watched.includes(s.skin) ? '<span class="tag quiet">Watching</span>' : ""}</div>
<div
    class="eyebrow ${esc(first?.tone ?? "muted")}">${esc(first?.kind ?? "signal")}</div>
<h2>${esc(first?.title)}</h2>
<p
    class="sub">${esc(first?.detail)}</p>${second ? `<p
    class="signalCaution">${esc(second.title)}</p>` : ""}<div
    class="signalBottom">
<span>${money(s.fair)} KR <small>estimate &middot; ${s.sales7d} sales / 7D</small>
</span>
<button
    class="textButton"
    data-skin="${esc(s.skin)}">Inspect item &#8594;</button>
</div>
</article>`;
        }).join("")}</div>` : `<section
    class="panel">${empty("No supported signals in this category", "Signals need enough observations to support a comparison. New evidence appears as the collector runs.")}</section>`) + "<p class=\"chartNote\">Signals are descriptive threshold checks. False-alert rates and predictive usefulness have not been measured; these observations are not trade recommendations. Sales reporting can be incomplete. Quote changes do not prove a sale. Dates are UTC.</p>" + `<details
    class="panel intelligenceDetails" ${advanced ? "open" : ""}>
<summary>Model track record &amp; data coverage</summary>${model && historical && forward ? `<p
    class="sub">A pooled regression learns from price movement, sales activity, dispersion, observation gaps and rarity across items. The target is the sales-weighted reported price over seven future UTC dates, conditional on sales. Historical tests use revised data and cannot establish live accuracy.</p>
<div
    class="tableWrap">
<table>
<thead>
<tr>
<th>Evaluation</th>
<th>Outcomes</th>
<th>Weeks</th>
<th>Log error</th>
<th>Error reduction</th>
<th>90% range coverage</th>
</tr>
</thead>
<tbody>
<tr>
<td>Historical holdouts</td>${metrics(historical)}</tr>
<tr>
<td>Actually issued</td>${metrics(forward)}</tr>
</tbody>
</table>
</div>
<p
    class="chartNote">Lower log error is better. Error reduction compares with the better of unchanged last price and the existing valuation baseline. Historical mean range width: ${percent(historical.width)} of the predicted price. Forward publication requires 200 outcomes, 20 items, four issue weeks, at least 5% lower error, 85-95% range coverage and mean range width no greater than the predicted price.</p>` : ""}<div
    class="coverageRow">
<span>
<b>${money(reply.coverage.dailyRows)}</b> daily observations</span>
<span>
<b>${money(reply.coverage.items)}</b> items with sales history</span>
</div>
<p
    class="chartNote">Sales history: ${esc(reply.coverage.firstDay ?? "Pending")} to ${esc(reply.coverage.lastDay ?? "Pending")}. Supply observations since ${reply.coverage.supplySince ? esc(new Date(reply.coverage.supplySince).toISOString().slice(0, 16).replace("T", " ")) : "collection began"}. ${model ? `Model trained ${esc(formatAge(Date.now() - model.trainedAt))} ago.` : ""}</p>${reply.sources.length ? `<div
    class="coverageRow">${reply.sources.map(s => `<span>${esc(s.source)}: ${s.records} records &middot; ${esc(formatAge(Date.now() - s.observedAt))} ago</span>`).join("")}</div>` : '<p class="chartNote">News and catalog feeds have not been collected yet.</p>'}</details>` + (reply.news.length ? `<section
    class="panel intelligenceDetails">
<h3>Official news</h3>${reply.news.map(n => `<p
    class="sub">${n.url ? `<button class="textButton" data-external-url="${esc(n.url)}">${esc(n.title)} &#8599;</button>` : esc(n.title)}</p>`).join("")}</section>` : "");
}
