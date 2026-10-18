import { money, identity } from "../presentation.js";
/** @param {import("../terminal.js").Terminal} desk  @param {import("../types.js").SkinSummary[]} items */
export function compactListView(desk, items){
    return `<div
    class="list">${items.map(s => `<button
    class="listRow"
    data-skin="${s.skin}">${identity(s)}<span
    class="listValue">${money(s.fair)} <span
    class="muted">KR</span>
<small>${s.sales7d} sold this week</small>
</span>
</button>`).join("")}</div>`;
}
