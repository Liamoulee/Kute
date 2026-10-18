import marketApi from "../api.js";
import { esc, change } from "../presentation.js";
const MINUTE = 60_000;
/** @param {import("../terminal.js").Terminal} desk  @return {Promise<import("../terminal.js").View>} */
export async function indicesView(desk){
    /** @type {import("../types.js").IndicesReply|null} */
    const result = await marketApi.cached("/market/indices", 60 * MINUTE);
    if (!result) return desk.unavailable();
    const selected = result.indices.find(i => i.name === desk.arg) ?? result.indices.find(i => i.name === "kute-100") ?? result.indices[0];
    return {
        asOf: result.asOf,
        html: desk.intro("The wider picture.", "Equal-weighted indices of eligible items. Base 100 at launch, rebalanced monthly.", '<button class="button" data-nav="overview">Market overview</button>') + `<section
    class="sectionGap panel">
<div
    class="panelHead">
<h3>${esc(selected?.name ?? "Index history")}</h3>
<small>${selected?.members ?? 0} items</small>
</div>
<div
    class="chart">
</div>
<p
    class="chartNote">A new index starts with one observation. Longer comparisons appear as its history grows.</p>
</section>
<div
    class="tableWrap">
<table>
<thead>
<tr>
<th>Index</th>
<th
    class="num">Level</th>
<th
    class="num">7D</th>
<th
    class="num">30D</th>
<th
    class="num">Items</th>
</tr>
</thead>
<tbody>${result.indices.map(i => `<tr
    class="clickable"
    tabindex="0"
    data-index-name="${esc(i.name)}">
<td>${esc(i.name)}</td>
<td
    class="num">${i.value.toFixed(2)}</td>
<td
    class="num">${change(i.change7d)}</td>
<td
    class="num">${change(i.change30d)}</td>
<td
    class="num">${i.members}</td>
</tr>`).join("")}</tbody>
</table>
</div>`,
        points: (selected?.series ?? []).map(p => ({
            t: Date.parse(p.day + "T00:00:00Z"),
            values: [p.value],
        })),
        series: [{
            label: selected?.name ?? "Index",
            color: "#f580b4",
        }],
    };
}
