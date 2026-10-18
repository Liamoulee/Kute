import marketApi from "../api.js";
import { TRADE_VERDICTS, esc, money, change, identity } from "../presentation.js";
import { itemSearch } from "../itemSearch.js";
/** @param {import("../terminal.js").Terminal} desk  @return {Promise<import("../terminal.js").View>} */
export async function analyzeView(desk){
    const {
        analyzer: a,
    } = desk;
    const hasItems = !!(a.give.length || a.get.length || a.giveKr || a.getKr);
    const v = hasItems ? await marketApi.analyze({
        give: a.give.map(({
            skin,
            count,
        }) => ({
            skin,
            count,
        })),
        get: a.get.map(({
            skin,
            count,
        }) => ({
            skin,
            count,
        })),
        giveKr: a.giveKr,
        getKr: a.getKr,
    }) : null;
    const side = (/** @type {"give"|"get"} */which) => {
        const priced = v?.[which];
        const kr = which === "give" ? a.giveKr : a.getKr;
        const unknown = priced?.items.some(i => i.unknown) ?? false;
        const count = a[which].reduce((sum, i) => sum + i.count, 0);
        let total = hasItems ? "Unavailable" : "0";
        if (priced) total = money(priced.value);
        return `<section
    class="tradeSide"
    aria-label="${which === "give" ? "You give" : "You receive"}">
<div
    class="tradeSideHead">
<h2>${which === "give" ? "You give" : "You receive"}</h2>
<span>${count} item${count === 1 ? "" : "s"}</span>
</div>
<div
    class="tradeTotal">
<strong>${total} <small>KR</small>
</strong>
<span>${unknown ? "Partial estimate. Unvalued items excluded." : "Estimated value, including KR"}</span>
</div>${itemSearch(`kmPick${which}`, which, "Add an item...")}<div
    class="tradeItems">${a[which].length ? a[which].map((i, index) => {
        const line = priced?.items.find(l => l.skin === i.skin);
        const value = line && !line.unknown ? money(line.lineValue) + " KR" : "Value unavailable";
        return `<div
    class="tradeItem">
<button
    class="remove"
    data-remove="${index}" data-side="${which}" aria-label="Remove ${esc(i.name)} from ${which === "give" ? "your side" : "their side"}">&times;</button>${identity(i)}<div
    class="tradeItemValue">${value}<small>${line && !line.unknown ? `${money(line.fair)} KR each` : "Needs more evidence"}</small>
</div>
<label
    class="tradeQuantity">Qty<input type="number" min="1" max="10000"
    value="${i.count}" data-count="${index}" data-side="${which}" aria-label="Quantity of ${esc(i.name)} on ${which === "give" ? "your side" : "their side"}">
</label>
</div>`;
    }).join("") : `<div class="tradeEmpty">
<span>+</span>Add items to this side<small>Search by name above</small>
</div>`}</div>
<label
    class="tradeKr">Additional KR<input type="number" min="0" max="1000000000"
    data-kr="${which}" value="${kr}">
</label>
</section>`;
    };
    let result = "<div class=\"tradeComparison muted\">Add items or KR to see the difference. Estimates update as you build the trade.</div>";
    if (hasItems && !v){
        result = `<div class="notice">${esc(marketApi.lastError || "Analysis unavailable.")} Your selected items are preserved. <button class="textButton" data-action="analyze">Try again</button>
</div>`;
    }
    if (v){
        const text = TRADE_VERDICTS[v.verdict].label;
        const color = {
            good: "positive",
            bad: "negative",
            fair: "",
            uncertain: "",
        }[v.verdict];
        result = `<div
    class="tradeComparison">
<div>
<div
    class="eyebrow">THE DIFFERENCE</div>
<div
    class="verdict ${color}">${text}</div>
<span
    class="muted">${TRADE_VERDICTS[v.verdict].detail}</span>
</div>
<div
    class="tradeDifference ${color}">
<strong>${v.difference > 0 ? "+" : ""}${money(v.difference)} <small>KR</small>
</strong>${change(v.differenceShare)}</div>
</div>
<ul
    class="insightList">${v.drivers.map(d => `<li>${esc(d)}</li>`).join("")}</ul>${desk.advanced ? `<details>
<summary>Heuristic liquidity adjustment</summary>
<div
    class="tradeAdjusted">
<div>
<span>You give</span>
<strong>${money(v.give.liquidValue)} KR</strong>
</div>
<div>
<span>You receive</span>
<strong>${money(v.get.liquidValue)} KR</strong>
</div>
</div>
<p>After grade and quantity discounts. These are illustrative adjustments, not forecasts of sale proceeds.</p>
</details>` : ""}`;
    }
    return {
        asOf: v?.asOf,
        html: desk.intro("Compare the trade.", "Your items on the left, theirs on the right. Add KR to either side.", '<button class="button" data-action="clear-trade">Clear trade</button>') + `<div
    class="tradeBoard">${side("give")}${side("get")}</div>
<div
    id="kmTradeOutcome"
    aria-live="polite">${result}</div>`,
    };
}
