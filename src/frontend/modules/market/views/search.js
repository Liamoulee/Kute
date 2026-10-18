import marketApi from "../api.js";
import { RARITIES } from "../types.js";
import { TYPE_NAMES, esc, money } from "../presentation.js";
import { itemSearch } from "../itemSearch.js";
const MINUTE = 60_000;
/** @param {import("../terminal.js").Terminal} desk  @return {Promise<import("../terminal.js").View>} */
export async function searchView(desk){
    const state = desk.searchState();
    const params = new URLSearchParams({
        sort: state.sort,
        page: String(state.page),
    });
    for (const [key, value] of Object.entries({
        q: state.q,
        rarity: state.rarity,
        type: state.type,
        budget: state.budget,
        min_sales: state.minSales,
    })) if (value !== "") params.set(key, value);
    /** @type {import("../types.js").SearchReply|null} */
    const result = await marketApi.cached(`/market/search?${params}`, MINUTE);
    if (!result) return desk.unavailable();
    const options = (/** @type {string[]} */names, /** @type {string} */selected) => names.map((n, i) => `<option
    value="${i}" ${String(i) === selected ? "selected" : ""}>${esc(n)}</option>`).join("");
    const pages = Math.max(1, Math.ceil(result.total / result.perPage));
    return {
        asOf: result.asOf,
        html: desk.intro(desk.tab === "active" ? "Find items that are trading." : "Find your next item.", desk.tab === "active" ? `At least ${state.minSales} reported sales in seven days. Ranked by trading activity by default.` : "Browse by budget, recent activity, or the items you already have in mind.", '<button class="button small" data-action="reset-search">Reset filters</button>') + `<form
    id="kmFilters"
    class="filterBar">${itemSearch("kmQ", "discover", "Search all items", state.q)}<input
    id="kmBudget" type="number" min="1"
    aria-label="Maximum asking price in KR"
    placeholder="Budget in KR"
    value="${esc(state.budget)}">
<select
    id="kmType"
    aria-label="Item type">
<option
    value="">All types</option>${options(TYPE_NAMES, state.type)}</select>${desk.advanced ? `<select
    id="kmRarity"
    aria-label="Rarity">
<option
    value="">All rarities</option>${options(RARITIES.map(r => r.name), state.rarity)}</select>` : `<input type="hidden"
    id="kmRarity"
    value="${esc(state.rarity)}">`}<select
    id="kmSales"
    aria-label="Minimum sales">${desk.tab === "active" ? "" : '<option value="">Any activity</option>'}${(desk.tab === "active" ? [5, 20] : [1, 5, 20]).map(n => `<option
    value="${n}" ${String(n) === state.minSales ? "selected" : ""}>${n}+ sales / 7D</option>`).join("")}</select>
<select
    id="kmSort"
    aria-label="Sort items">${[["volume", "Most traded"], ["value", "Highest value"], ["trend7d", "7D gainers"], ["liquidity", "Most active"], ["name", "Name"]].map(([v, n]) => `<option
    value="${v}" ${v === state.sort ? "selected" : ""}>${n}</option>`).join("")}</select>
<button type="button"
    class="button small"
    data-action="filters">Apply</button>
</form>` + desk.table(result.items) + `<div
    class="pagination">
<span>${money(result.total)} matching items</span>
<div
    class="row">
<button
    class="button small"
    data-page="${state.page - 1}" ${state.page <= 1 ? "disabled" : ""}>Previous</button>
<span>${state.page} / ${pages}</span>
<button
    class="button small"
    data-page="${state.page + 1}" ${state.page >= pages ? "disabled" : ""}>Next</button>
</div>
</div>`,
    };
}
