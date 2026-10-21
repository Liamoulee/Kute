import { html } from "../element.js";
import marketApi from "../api.js";
import { esc, money, change, identity, empty, stat, fairValue } from "../presentation.js";
import { itemSearch } from "../itemSearch.js";
const MINUTE = 60_000;
/** @param {import("../terminal.js").Terminal} desk  @return {Promise<import("../terminal.js").View>} */
export async function portfolioView(desk){
    let name = typeof desk.arg === "string" ? desk.arg : "";
    if (!name){
        try {
            name = localStorage.getItem("krunker_username") ?? "";
        }
        catch {
            name = "";
        }
    }
    const heading = desk.intro("Know what you hold.", "A view of today's holdings, their estimated value, and where it is concentrated.");
    const form = html`
        <div class="filterBar">
            <input id="kmName" aria-label="Inventory username" placeholder="Krunker username" value="${esc(name)}" />
            <button class="button" data-action="inventory">View inventory</button>
        </div>
    `;
    if (!name){
        return {
            html: heading + form + empty("Choose an inventory", "Enter a username to value its public inventory."),
        };
    }
    /** @type {import("../types.js").PortfolioReply|null} */
    const p = await marketApi.cached(`/market/portfolio?name=${encodeURIComponent(name)}`, 5 * MINUTE);
    if (!p){
        return {
            html:
                heading +
                form +
                empty(
                    "Inventory is unavailable",
                    "The player may not exist, or their inventory could not be loaded.",
                    '<button class="button" data-action="retry">Try again</button>',
                ),
        };
    }
    const coverage = new Map(p.historyCoverage?.map((r) => [r.day, r]) ?? []);
    const basket = p.historyBasket;
    const historySeries = basket?.series ?? p.series;
    const chartTitle = basket && basket.items < basket.total ? "Price history of covered holdings" : "Today's holdings through time";
    const chartDescription = basket
        ? `${basket.items} of ${basket.total} item types have continuous price coverage, representing ${Math.round(basket.valueShare * 100)}% of today's estimated value. The chart keeps the same items throughout.`
        : "Incomplete valuation periods are omitted.";
    const historyPanel = historySeries.length
        ? html`
              <div class="chart"></div>
              <p class="chartNote">
                  ${esc(chartDescription)} Historical prices applied to what you own today; this is not personal profit. Marks expire after
                  30 days without a new sale.
              </p>
          `
        : '<p class="sub">There is not enough continuous price coverage to chart these holdings yet. Your current estimates are listed below.</p>';
    return {
        asOf: p.asOf,
        holdings: p.items,
        html:
            heading +
            form +
            html`
                <div class="metrics">
                    ${stat(
                        "Estimated inventory value",
                        html`
                            ${money(p.totalValue)}
                            <span class="unit">KR</span>
                        `,
                        `${p.items.length - (p.noEvidenceItems ?? 0)} valued item types`,
                    )}${stat(
                        "In more active items",
                        html`
                            ${Math.round(p.liquidShare * 100)}
                            <span class="unit">%</span>
                        `,
                        "Share in activity grades A to C",
                    )}${stat(
                        "Largest two positions",
                        html`
                            ${Math.round(p.concentration * 100)}
                            <span class="unit">%</span>
                        `,
                        "Of estimated inventory value",
                    )}
                </div>
                ${p.limitedEvidenceItems
                    ? html`
                          <div class="notice">
                              ${p.limitedEvidenceItems} item types (${money(p.limitedEvidenceValue)} KR of the total) have limited sales
                              evidence or use fallback estimates.
                          </div>
                      `
                    : ""}${p.noEvidenceItems
                    ? html`
                          <div class="notice">
                              ${p.noEvidenceItems} item types have no price evidence and are not in the total. At the quick-sell floor or
                              Krunker's estimate they would add ${money(p.noEvidenceReference ?? 0)} KR, but such items are often worth far more.
                          </div>
                      `
                    : ""}${p.unvaluedItems
                    ? html`
                          <div class="notice">${p.unvaluedItems} item types have no usable valuation and are excluded from the total.</div>
                      `
                    : ""}
                <section class="sectionGap panel">
                    <div class="panelHead">
                        <h3>${chartTitle}</h3>
                        <small>90 days</small>
                    </div>
                    ${historyPanel}
                </section>
                <div class="filterBar">
                    ${itemSearch("kmHoldingFilter", "holdings", "Filter your holdings", desk.portfolioFilter)}
                    <span class="muted">Largest positions first</span>
                </div>
                <div class="tableWrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Item</th>
                                <th class="num">Quantity</th>
                                <th class="num">Estimate / KR</th>
                                <th class="num">Position / KR</th>
                                <th class="num">7D change</th>
                                ${desk.advanced ? "<th>Activity grade</th>" : ""}
                            </tr>
                        </thead>
                        <tbody>
                            ${p.items
                                .map(
                                    (i) => html`
                                        <tr class="clickable" data-skin="${esc(i.skin)}" tabindex="0">
                                            <td>${identity(i)}</td>
                                            <td class="num">${i.count}</td>
                                            <td class="num">${fairValue(i)}</td>
                                            <td class="num">${i.noEvidence ? '<span class="noEvidence">Not counted</span>' : money(i.value)}</td>
                                            <td class="num">${change(i.trend7d)}</td>
                                            ${desk.advanced
                                                ? html`
                                                      <td>${esc(i.grade)}</td>
                                                  `
                                                : ""}
                                        </tr>
                                    `,
                                )
                                .join("")}
                        </tbody>
                    </table>
                </div>
            `,
        points: historySeries.map((s) => ({
            t: Date.parse(s.day + "T00:00:00Z"),
            values: [!basket && coverage.has(s.day) && coverage.get(s.day)?.priced !== coverage.get(s.day)?.total ? null : s.value],
        })),
        series: [
            {
                label: "Covered holdings at historical prices",
                color: "#f580b4",
            },
        ],
    };
}
