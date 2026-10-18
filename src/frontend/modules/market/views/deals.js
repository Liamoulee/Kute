import marketApi from "../api.js";
import { esc, money, identity, empty } from "../presentation.js";
import { dealEvidence } from "../intelligence.js";
const MINUTE = 60_000;
/** @param {import("../terminal.js").Terminal} desk  @return {Promise<import("../terminal.js").View>} */
export async function dealsView(desk){
    const budget = /** @type {{budget?:string}|null} */(desk.arg)?.budget ?? "";
    const filters = `<div
    class="filterBar">
<input
    id="kmDealBudget" type="number" min="1"
    value="${esc(budget)}"
    placeholder="Budget in KR"
    aria-label="Maximum deal price">
<button
    class="button small"
    data-action="deal-budget">Apply budget</button>
</div>`;
    /** @type {import("../types.js").DealsReply|null} */
    const result = await marketApi.cached(`/market/deals?min_grade=C&limit=100&budget=${encodeURIComponent(budget)}`, MINUTE);
    if (!result) return desk.unavailable();
    return {
        asOf: result.asOf,
        asOfLabel: "Quotes observed",
        html: desk.intro("Worth a closer look.", "Observed asks below a sales-based estimate. Inspect the evidence before deciding.") + filters + (result.deals.length ? `<div
    class="tableWrap">
<table>
<thead>
<tr>
<th>Item</th>
<th
    class="num">Ask / KR</th>
<th
    class="num">Estimate / KR</th>
<th
    class="num">Below estimate</th>
<th>Sales / 7D</th>
</tr>
</thead>
<tbody>${result.deals.map(d => `<tr
    class="clickable"
    tabindex="0"
    data-skin="${d.skin}">
<td>${identity(d)}${dealEvidence(d)}</td>
<td
    class="num">${money(d.price)}</td>
<td
    class="num">${money(d.fair)}</td>
<td
    class="num positive">${Math.round(d.discount * 100)}%</td>
<td>
<span
    class="tag quiet">${d.sales7d ?? "Unknown"}</span>
</td>
</tr>`).join("")}</tbody>
</table>
</div>
<p
    class="chartNote">A discount is not a predicted profit. Ranked by discount, sales support and observed risks. The scanner checks recent lower prices, unstable prices, supply changes and concentrated listings. Quotes older than three hours are excluded; availability can still change.</p>` : '<section class="panel">' + empty("No supported candidates right now", "The scanner only includes sales-based estimates with sufficient activity and a meaningful discount. Your watchlist can track specific items in the meantime.", '<button class="button" data-nav="watchlist">Open watchlist</button>') + "</section>"),
    };
}
