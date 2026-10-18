import marketApi from "../api.js";
import { TITLES } from "../navigation.js";
import { RARITIES, formatAge } from "../types.js";
import { TYPE_NAMES, esc, money, change, evidenceLabel, activityLabel, empty, stat } from "../presentation.js";
import { readWatchlist } from "../watchlist.js";
import { itemDesk } from "../analytics.js";
import { itemIntelligence } from "../intelligence.js";
import { contributionEvidence } from "../contributionEvidence.js";
const RANGES = ["1D", "7D", "1M", "3M", "1Y", "ALL"];

/** @param {import("../terminal.js").Terminal} desk  @return {Promise<import("../terminal.js").View>} */
export async function itemView(desk){
    const state = desk.itemState();
    const historyRange = !state.candles && state.range === "7D" ? "1M" : state.range;
    /** @type {{item:import("../types.js").ItemPage,history:import("../types.js").HistoryReply|null,listings:import("../types.js").ListingsReply|null}|null} */
    const reply = await marketApi.itemDesk(state.skin, historyRange);
    const {
        item: page,
        history,
        listings,
    } = reply ?? {};
    if (!page) return desk.unavailable();
    const s = page.skin;
    const e = page.evidence;
    const watched = readWatchlist().some(w => w.skin === s.skin);
    const range = e?.dailyRange;
    const recent = e ? `${e.sales} sales across ${e.days} trading days in 30D` : `${page.liquidity.sales30d} sales in 30 days`;
    const reasons = e?.reasons ?? [recent, `The estimate is based on ${s.method.startsWith("sales") ? "historical sales aggregates" : "limited market evidence"}.`];
    const series = [{
        label: history?.resolution === "hour" ? "Lowest observed ask" : "Daily average sale",
        color: "#f580b4",
    }];
    if (state.overlay !== "none"){
        series.push({
            label: ({
                fair: "Kute estimate",
                lowest: "Lowest observed ask",
                krunker: "Krunker estimate",
            })[state.overlay] ?? "Comparison",
            color: "#87b8f7",
        });
    }
    const points = (history?.points ?? []).filter(p => historyRange === state.range || p.t >= Date.now() - 7 * 86_400_000).map(p => ({
        t: p.t,
        values: [history?.resolution === "hour" ? p.lowest : p.avg, ...(series.length > 1 ? [({
            fair: p.fair,
            lowest: p.lowest,
            krunker: p.krunker,
        })[state.overlay] ?? null] : [])],
        volume: history?.resolution === "day" && p.salesObserved !== false ? p.sales : null,
        ask: p.ask,
    }));
    let chartNote = "Daily average completed-sale prices. Today's point, when present, is incomplete. Gaps mean no sale-price observation.";
    if (history?.resolution === "hour") chartNote = "Intraday history shows sampled asks. Official sales data is daily; individual transaction timing is unavailable.";
    if (state.candles) chartNote = "Candles describe sampled asking prices, including historical quote changes. They are not transaction candles. Unsampled periods remain empty.";
    const visiblePoints = Math.max(8, Math.ceil(points.length / state.zoom));
    const panStep = Math.max(1, Math.floor(visiblePoints / 2));
    const listingRows = (listings?.listings ?? []).slice(0, desk.advanced ? 250 : 5);
    const bookAt = listings?.observedAt ?? e?.bookAt;
    const stale = !bookAt || Date.now() - bookAt > 3 * 3_600_000;
    const premiumTable = (/** @type {import("../types.js").InstanceBracket[]} */brackets) => `<div
    class="tableWrap">
<table>
<thead>
<tr>
<th>Attribute</th>
<th
    class="num">Observed instances</th>
<th>Premium</th>
</tr>
</thead>
<tbody>${brackets.map(b => `<tr>
<td>${esc(b.label)}</td>
<td
    class="num">${b.count}</td>
<td>${b.premium === null ? "Not established" : change(b.premium)}</td>
</tr>`).join("")}</tbody>
</table>
</div>`;
    return {
        item: page,
        listings,
        asOf: s.valuedAt ?? page.asOf,
        points: history ? points : undefined,
        series,
        chartOptions: {
            candles: state.candles,
            volume: history?.resolution === "day",
            zoom: state.zoom,
            stepMs: history?.resolution === "hour" ? 3_600_000 : 86_400_000,
            offset: state.offset,
        },
        html: `<button
    class="textButton"
    data-action="back">&#8592; Back to ${esc(TITLES[/** @type {keyof typeof TITLES} */(desk.previous)] ?? "Discover")}</button>
<div
    class="itemHero">
<div
    class="itemArt">${s.thumbnail ? `<img src="${esc(s.thumbnail)}" alt="${esc(s.name)}">` : "K"}</div>
<div>
<div
    class="eyebrow">${esc(RARITIES[s.rarity]?.name)} &middot; ${esc(TYPE_NAMES[s.type])}${s.season ? ` &middot; Season ${s.season}` : ""}</div>
<h1>${esc(s.name)}</h1>
<p
    class="sub">${esc(activityLabel(s))} <span
    class="muted">&middot;</span> ${esc(evidenceLabel(s))}</p>
</div>
<div
    class="itemActions">
<button
    class="button ${watched ? "" : "primary"}" data-action="watch">${watched ? "Watching" : "+ Watch item"}</button>
</div>
</div>` + `<div
    class="metrics">${stat("Kute estimate", `${money(s.fair)} <span
    class="unit">KR</span>`, esc(recent))}${stat("Lowest observed ask", s.lowest === null ? "None listed" : `${money(s.lowest)} <span
    class="unit">KR</span>`, s.spread !== null ? change(s.spread) + ` vs estimate${stale ? " &middot; quote needs updating" : ""}` : "No available quote")}${stat("Sales in the last 7 days", String(s.sales7d), `${s.onS} currently listed &middot; ${money(s.inC)} in circulation`)}</div>` + `<section
    class="sectionGap panel">
<div
    class="panelHead">
<h3>Price history</h3>
<div
    class="segmented">${RANGES.map(r => `<button
    data-range="${r}" class="${state.range === r ? "on" : ""}">${r}</button>`).join("")}</div>
</div>
<div
    class="controlsGap row">
<div
    class="segmented">
<button
    data-chart-mode="line"
    class="${!state.candles ? "on" : ""}">Line</button>
<button
    data-chart-mode="candles"
    class="${state.candles ? "on" : ""}">Ask candles</button>
</div>
<label
    class="field">
<span
    class="srOnly">Chart comparison</span>
<select
    id="kmOverlay">${[["none", "No comparison"], ["fair", "Kute estimate"], ["lowest", "Lowest ask"], ["krunker", "Krunker estimate"]].map(([v, n]) => `<option
    value="${v}" ${state.overlay === v ? "selected" : ""}>${n}</option>`).join("")}</select>
</label>
<span
    class="spacer">
</span>
<button
    class="button small"
    data-zoom="${Math.min(8, state.zoom * 2)}" ${state.zoom >= 8 ? "disabled" : ""}>Zoom in</button>
<button
    class="button small"
    data-pan="${Math.min(Math.max(0, points.length - visiblePoints), state.offset + panStep)}" ${state.offset + visiblePoints >= points.length ? "disabled" : ""}>Older</button>
<button
    class="button small"
    data-pan="${Math.max(0, state.offset - panStep)}" ${!state.offset ? "disabled" : ""}>Newer</button>
<button
    class="button small"
    data-zoom="1">Reset</button>
</div>
<div
    class="chartLegend">${state.candles ? '<span><i class="legendAsk"></i>Observed ask OHLC</span>' + series.slice(1).map(line => `<span>
<i
    style="background:${line.color}">
</i>${esc(line.label)}</span>`).join("") : series.map(line => `<span>
<i
    style="background:${line.color}">
</i>${esc(line.label)}</span>`).join("")}${history?.resolution === "day" ? "<span>Bars: reported sales</span>" : ""}</div>
<div
    class="chart">${history ? "" : empty("History unavailable", "Price history could not be loaded. Try again in a moment.", '<button class="button small" data-action="retry">Try again</button>')}</div>
<p
    class="chartNote">${history ? chartNote : ""} Dates and times are UTC.</p>
</section>` + itemIntelligence(page.intelligence) + (desk.advanced ? itemDesk(page) + contributionEvidence(page.contributions) : "") + `<div
    class="equal">
<section
    class="panel">
<div
    class="eyebrow">THE CONTEXT</div>
<h2>What the data says</h2>
<ul
    class="insightList">${reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul>
</section>
<section
    class="panel">
<div
    class="eyebrow">RECENT PRICE RANGE</div>
<h2>${range ? `${money(range.low)} to ${money(range.high)} KR` : "More trading history needed"}</h2>
<p
    class="sub">${range ? "Central range of observed daily average prices over 30 days. This is historical context, not a forecast." : "A useful range needs several completed trading days."}</p>${range ? `<div
    class="rangeTrack">
<i
    style="left:${Math.max(0, Math.min(100, (s.fair - range.low) / Math.max(1, range.high - range.low) * 100))}%">
</i>
</div>
<div
    class="breadthLabels">
<span
    class="muted">${money(range.low)}</span>
<span
    class="accent">Current estimate</span>
<span
    class="muted">${money(range.high)}</span>
</div>` : ""}<p
    class="noteTop sub">Krunker estimate: ${money(s.krunker)} KR${s.floor > 0 ? ` &middot; Game quick-sell value: ${money(s.floor)} KR` : " &middot; Not eligible for quick sell"}</p>
</section>
</div>` + `<section
    class="sectionGap panel">
<div
    class="panelHead">
<div>
<h3>Plan an asking price</h3>
<p
    class="sub">Compare your price with the listings already competing for buyers.</p>
</div>
<span
    class="tag quiet">Price comparison</span>
</div>
<div
    class="row">
<label
    class="field">Asking price / KR<input
    id="kmSellPrice" type="number" min="1"
    value="${s.lowest ?? s.fair}">
</label>
<label
    class="field">Quantity<input
    id="kmSellQuantity" type="number" min="1" max="10000"
    value="1">
</label>
<div
    id="kmPlannerResult" class="plannerResult">
</div>
</div>
<p
    class="chartNote">This comparison does not predict when a listing will sell. Gross proceeds exclude listing fees and assume every unit sells at your ask.</p>
</section>` + `<div
    class="panelHead">
<h3>Available listings</h3>
<small>${listings ? listings.total : "Unknown total"} reported listed${bookAt ? ` &middot; observed ${formatAge(Date.now() - bookAt)} ago` : " &middot; freshness unknown"}</small>
</div>${stale ? "<div class=\"notice\">These quotes need a fresh market observation. A listing may have changed or sold since it was last seen.</div>" : ""}${desk.advanced ? `<div class="filterBar">
<input id="kmListingMax" type="number" min="1" placeholder="Max ask / KR" aria-label="Maximum listing price">
<input id="kmSerialMax" type="number" min="1" placeholder="Max serial" aria-label="Maximum serial number">
<input id="kmWearMax" type="number" min="0" max="1" step="0.01" placeholder="Max wear" aria-label="Maximum wear">
<input id="kmAgeMax" type="number" min="0" step="0.5" placeholder="Max age in days" aria-label="Maximum listing age in days">
<input id="kmSellerMax" type="number" min="1" placeholder="Max seller supply" aria-label="Maximum sampled listings from one seller">
</div>` : ""}` + (listingRows.length ? `<div
    class="tableWrap">
<table>
<thead>
<tr>
<th
    class="num">Ask / KR</th>
<th
    class="num">vs estimate</th>
<th>Seller</th>${desk.advanced ? "<th>Listed for</th><th>Instance</th><th class=\"num\">Seller supply</th>" : ""}</tr>
</thead>
<tbody
    id="kmListingRows">${listingRows.map(l => `<tr
    data-price="${l.price}" data-serial="${l.serial ?? ""}" data-wear="${l.wear ?? ""}" data-age="${l.ageMs === null ? "" : Math.max(0, l.ageMs) / 86_400_000}" data-seller-count="${l.sellerListings > 0 ? l.sellerListings : ""}">
<td
    class="num">${money(l.price)}</td>
<td
    class="num">${change(l.price / s.fair - 1)}</td>
<td>${esc(l.seller ?? "Unavailable")}</td>${desk.advanced ? `<td
    class="muted">${l.ageMs === null ? "Unknown" : formatAge(l.ageMs)}</td>
<td
    class="muted">${l.serial !== null ? `#${l.serial}` : ""}${l.wear !== null ? ` &middot; wear ${l.wear.toFixed(3)}` : ""}</td>
<td
    class="num muted">${l.sellerListings > 0 ? l.sellerListings : "Unknown"}</td>` : ""}</tr>`).join("")}</tbody>
</table>
</div>
<p
    class="chartNote">
<span
    id="kmListingCount">Showing ${listingRows.length} sampled listings of ${listings?.total ?? "unknown"} reported.</span> Seller supply counts all sampled listings from that seller. ${listings && listings.total > (listings.observedTotal ?? listings.listings.length) ? "The upstream listing sample does not cover the full market." : ""}</p>` : empty("No observed listings", "No quotes are available in the current sample. Watch this item and check back.")) + (desk.advanced && page.depth ? `<details>
<summary>Order-book sample</summary>
<div
    class="metricsGap metrics">${stat("Sampled listings", String(page.depth.total), "Observed quotes, not the whole market")}${stat("Median sampled ask", `${money(page.depth.median)} <span
    class="unit">KR</span>`, "An offer to sell, not a sale price")}${stat("Sampled sellers", String(page.depth.sellers), `${page.depth.maxByOne} listings from the largest sampled seller`)}</div>
<p>The middle half of sampled asks runs from ${money(page.depth.p25)} to ${money(page.depth.p75)} KR. ${money(page.depth.depthKr)} KR is offered across the sample; this does not measure buyer demand.</p>
</details>` : "") + `<details>
<summary>Supply and ownership</summary>
<p>${money(s.inC)} units in circulation. ${s.onS} listed for sale.${page.ownership?.top1Share !== null && page.ownership?.top1Share !== undefined ? ` The top holder owns ${(page.ownership.top1Share * 100).toFixed(1)}% of supply.` : " Top-holder concentration is unknown."}${page.ownership?.top10Share !== null && page.ownership?.top10Share !== undefined ? ` The top ten hold ${(page.ownership.top10Share * 100).toFixed(1)}%.` : ""}${s.noSpin ? " This item is not available from spins; other supply sources may still apply." : ""}</p>${desk.advanced && page.ownership?.topOwners.length ? `<div
    class="contentTop tableWrap">
<table>
<thead>
<tr>
<th>Observed top holders</th>
<th
    class="num">Units</th>
</tr>
</thead>
<tbody>${page.ownership.topOwners.slice(0, 10).map(owner => `<tr>
<td>${esc(owner.name)}</td>
<td
    class="num">${money(owner.count)}</td>
</tr>`).join("")}</tbody>
</table>
</div>
<p>Up to ten holders from the latest cached owner sample. This is not a complete ownership census.</p>` : ""}</details>` + (page.instances && desk.advanced ? `<details>
<summary>Instance attributes / ${page.instances.registered} observed</summary>
<p>The registry may favour low serials and extreme wear. These counts describe observed instances. Sale-based premiums need validated evidence.</p>
<div
    class="contentTop equal">${premiumTable(page.instances.serial)}${premiumTable(page.instances.wear)}</div>
</details>` : ""),
    };
}
