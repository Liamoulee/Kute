import { esc, money } from "./presentation.js";

/** @typedef {import("./types.js").ContributionEvidence} Evidence */

/** @param {Evidence|undefined} evidence */
export function contributionEvidence(evidence){
    if (!evidence || !evidence.trades30d && !evidence.sales30d) return "";
    const { cash, sales, swaps } = evidence;
    return `<section class="panel" id="kmContributions">
        <div class="panelHead"><h2>Completed trade reports</h2><span class="tag quiet">30 days</span></div>
        <p>${money(evidence.trades30d)} reported private trades involved this item.
        ${money(evidence.matchedSales30d)} of ${money(evidence.sales30d)} contributed market sales match independently sampled listings and fit official daily totals.</p>
        ${cash ? `<p><b>Item-for-KR exchanges:</b> median ${money(cash.median)} KR per unit across ${esc(cash.samples)} reports.
        The middle half was ${money(cash.low)} to ${money(cash.high)} KR.</p>` : ""}
        ${sales ? `<p><b>Matched market-sale sample:</b> median ${money(sales.median)} KR across ${esc(sales.samples)} reports,
        with the middle half from ${money(sales.low)} to ${money(sales.high)} KR.</p>` : ""}
        ${swaps.length ? `<div class="tableWrap"><table><thead><tr><th>Exchanged item</th><th class="num">Units per one of this item</th><th class="num">Reports</th></tr></thead>
        <tbody>${swaps.map(s => `<tr><td><button class="textButton" data-skin="${esc(s.skin)}">${esc(s.name)}</button></td>
        <td class="num">${s.median.toFixed(2)} <span class="muted">(${s.low.toFixed(2)} to ${s.high.toFixed(2)})</span></td><td class="num">${esc(s.samples)}</td></tr>`).join("")}</tbody></table></div>` : ""}
        <p class="chartNote">These are client-reported observations, not a complete trade history or independently verified private transactions.
        Comparisons require multiple reports, source sessions and dates; source sessions do not identify unique players.
        These descriptive samples exclude bundles and reported serial, wear, style and paint attributes.
        The valuation model separately uses supported bundles with KR anchors; its contribution is explained above.</p>
    </section>`;
}
