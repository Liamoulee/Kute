import { esc, money, change, stat, TYPE_NAMES } from "./presentation.js";
import { formatAge } from "./types.js";

/** @param {number|null|undefined} value @param {string} [suffix] */
const decimal = (value, suffix = "") => value === null || value === undefined ? "Unavailable" : value.toFixed(1) + suffix;
/** @param {number|null|undefined} value */
const percent = (value) => value === null || value === undefined ? "Unavailable" : decimal(value * 100, "%");
/** @param {number|null|undefined} value */
const kr = (value) => value === null || value === undefined ? "Unavailable" : `${money(value)} <span class="unit">KR</span>`;
/** @param {number|null|undefined} at */
const age = (at) => at ? `${formatAge(Math.max(0, Date.now() - at))} ago` : "freshness unknown";
/** @param {string} label @param {string} value @param {string} note */
const row = (label, value, note) => `<div class="analyticsRow"><div>${label}<small>${note}</small></div><strong>${value}</strong></div>`;

/** @param {import("./types.js").ItemPage} page */
export function itemDesk(page){
    const a = page.analytics;
    if (!a) return '<section class="panel analyticsDesk"><h3>Advanced analytics unavailable</h3><p class="sub">This server does not yet provide the detailed metrics for this item.</p></section>';
    const { book } = a;
    const freshBook = !!book.observedAt && Date.now() - book.observedAt <= 3 * 3_600_000;
    const distance = (/** @type {number|null} */ average) => a.latest !== null && average !== null ? `${change(a.latest / average - 1)} latest daily mean vs average` : "Needs consecutive daily sale prices";
    const {position} = a.range90;
    const ladder = book.ladder.length ? `<div class="tableWrap"><table class="depthTable"><thead><tr><th>Ask ceiling</th><th class="num">Listings</th><th class="num">Total asks / KR</th></tr></thead><tbody>${book.ladder.map((l) => `<tr><td>${money(l.price)} KR<small>${l.premium ? `Within +${Math.round(l.premium * 100)}% of lowest` : "At the lowest ask"}</small></td><td class="num"><div class="depthAmount"><i style="width:${l.count / book.sampled * 100}%"></i><span>${l.count}</span></div></td><td class="num">${money(l.kr)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="sub">The next successful book observation will populate the ask ladder.</p>';
    return `<section class="analyticsDesk" id="kmAnalytics"><div class="panelHead"><div><div class="eyebrow">ADVANCED / TRADING DESK</div><h2>Price, activity &amp; supply</h2><p class="sub">Completed daily means through ${esc(a.throughDay)} UTC. ${a.observedDays30} of 30 days have observed sale prices.</p></div><span class="tag quiet">Descriptive analytics</span></div>`
        + `<div class="analyticsStrip"><span>Sale-price return / 7D <b>${change(a.change7d)}</b></span><span>30D <b>${change(a.change30d)}</b></span><span>Latest daily mean <b>${kr(a.latest)}</b></span></div>`
        + `<div class="analyticsGrid">${stat("Sales-weighted price / 30D", kr(a.weightedPrice30), a.weightedPrice30 === null ? "No completed sale-price observations" : `${change(a.estimateVsWeighted)} Kute estimate vs benchmark`)}${stat("Simple moving average / 7D", kr(a.sma7), distance(a.sma7))}${stat("Simple moving average / 30D", kr(a.sma30), distance(a.sma30))}${stat("RSI / 14 periods", decimal(a.rsi14), a.rsi14 === null ? `Needs 15 consecutive priced days; ${a.consecutiveDays} available` : "Wilder smoothing of daily sale means; scale 0 to 100")}${stat("Daily volatility / 30D", percent(a.dailyVolatility30), `${a.returnPairs30} adjacent daily returns; needs 10; not annualized`)}${stat("Max drawdown / 90D", percent(a.maxDrawdown90), `${a.observedDays90} priced days; gaps can hide larger declines`)}${stat("Range position / 90D", percent(position), a.range90.low !== null ? `${money(a.range90.low)} to ${money(a.range90.high)} KR in daily means` : "Needs at least 5 observed price days")}${stat("Reported turnover / 30D", kr(a.turnover30d), "Daily mean price multiplied by units sold")}</div>`
        + `<div class="equal"><section class="panel"><div class="panelHead"><h3>Activity &amp; supply pressure</h3><small>Supply ${age(a.statsAt)}</small></div>`
        + row("Weekly sales", a.reportedDays7 ? `${money(a.sales7d)} units` : "No reports", `${a.priorReportedDays7 ? money(a.priorSales7d) : "No reports"} in the prior week; reports on ${a.reportedDays7}/7 and ${a.priorReportedDays7}/7 days`)
        + row("Relative weekly volume", decimal(a.activityRatio, "x"), "Latest 7 days / prior 7; requires reports for both full weeks")
        + row("Listed supply / daily sales", decimal(a.daysListedAtRecentPace, " days"), "Reported listings / recent daily sales; a supply ratio, not time to sell")
        + row("Circulating supply listed", percent(a.listedShare), `${money(a.reportedListed)} reported listed / ${money(a.circulation)} circulating`)
        + row("30D turnover / circulation", percent(a.turnoverShare), "Reported units sold / current supply; an item can trade more than once")
        + '</section><section class="panel"><div class="panelHead"><h3>Ask-side depth ladder</h3><small>' + age(book.observedAt) + "</small></div>"
        + (freshBook ? "" : '<p class="notice">This book needs a fresh observation. The ladder describes the stored sample.</p>') + ladder
        + `<p class="chartNote">Cumulative counts in ${book.sampled} sampled listings; ${a.reportedListed} reported listed. These rows overlap. ${book.belowEstimate} sampled asks are below the Kute estimate.</p><div class="analyticsRow"><div>Largest observed seller<small>${book.sellers} identified sellers; identity available for ${book.knownSellerListings}/${book.sampled} listings</small></div><strong>${percent(book.largestSellerShare)}</strong></div></section></div>`
        + "<details><summary>Read the metrics</summary><p>All technical indicators use completed daily average sale prices, not exchange closing prices or individual transactions. Moving averages require every day in their window. RSI resets at a missing price day; a flat sequence is shown as 50. A high or low RSI describes past momentum and does not establish a buy or sell signal.</p><p>Volatility is the sample standard deviation of log returns between adjacent observed days. Drawdown is the largest observed peak-to-trough decline. The sales-weighted benchmark weights each daily mean by its reported sale count. Missing days are excluded, never treated as zero-price trades.</p><p>The ladder contains asking prices only. We have no bid book, so it cannot measure bid/ask spread, execution slippage, or buyer demand. Supply ratios require a supply observation within 24 hours. These metrics do not enable unvalidated forecasts.</p></details></section>";
}

/** @param {import("./types.js").OverviewReply} overview */
export function marketDesk(overview){
    const d = overview.diagnostics;
    const b = overview.breadth;
    if (!d || !b) return "";
    return `<section class="panel analyticsDesk" id="kmMarketDiagnostics"><div class="panelHead"><div><div class="eyebrow">ADVANCED / MARKET DIAGNOSTICS</div><h2>How broad is the move?</h2></div><span class="tag quiet">${b.eligible} eligible items</span></div><div class="analyticsGrid">${stat("Advance / decline ratio", decimal(d.advanceDeclineRatio, "x"), `${b.rising} rising / ${b.falling} falling; 0.5% movement threshold`)}${stat("Median item return / 7D", change(d.medianChange), "Equal item weighting among eligible estimates")}${stat("Middle half of returns", `${change(d.lowerQuartile)} to ${change(d.upperQuartile)}`, "25th to 75th percentile; dispersion across items")}${stat("Top 10 turnover share", percent(d.top10VolumeShare), "Concentration of 30D KR turnover in eligible items")}</div><div class="tableWrap"><table><thead><tr><th>Category</th><th class="num">Eligible</th><th class="num">7D median</th><th class="num">Rising / falling</th><th class="num">30D KR turnover</th><th class="num">Turnover share</th></tr></thead><tbody>${(overview.categories ?? []).map((c) => `<tr class="clickable" tabindex="0" data-category="${c.type}"><td>${esc(TYPE_NAMES[c.type] ?? "Other")}</td><td class="num">${c.items}</td><td class="num">${change(c.change)}</td><td class="num">${c.rising ?? "?"} / ${c.falling ?? "?"}</td><td class="num">${money(c.volume)}</td><td class="num">${percent(d.eligibleVolume > 0 ? c.volume / d.eligibleVolume : null)}</td></tr>`).join("")}</tbody></table></div><p class="chartNote">Coverage: ${b.eligible} of ${money(b.total)} tradable items. Requires a sales-based estimate updated within 24 hours, at least 5 sales in 7 days, and a measured 7D trend. Turnover shares describe this eligible set, not the entire market. Price changes use Kute estimates.</p></section>`;
}
