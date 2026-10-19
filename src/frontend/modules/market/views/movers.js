import { html } from "../element.js";
import marketApi from "../api.js";
import { money, change, identity } from "../presentation.js";
const MINUTE = 60_000;
/** @param {import("../terminal.js").Terminal} desk  @return {Promise<import("../terminal.js").View>} */
export async function moversView(desk){
    const window = typeof desk.arg === "string" ? desk.arg : "7D";
    /** @type {import("../types.js").MoversReply|null} */
    const m = await marketApi.cached(`/market/movers?window=${window}`, 5 * MINUTE);
    if (!m) return desk.unavailable();
    const list = (/** @type {typeof m.gainers} */ rows) => html`
        <div class="list">
            ${rows
                .slice(0, 10)
                .map(
                    (s) => html`
                        <button class="listRow" data-skin="${s.skin}">
                            ${identity(s)}
                            <span class="listValue">
                                ${change(s.change)}
                                <small>${money(s.fair)} KR &middot; ${s.sales7d} sales / 7D</small>
                            </span>
                        </button>
                    `,
                )
                .join("") || '<p class="sub">No eligible items in this period.</p>'}
        </div>
    `;
    return {
        asOf: m.asOf,
        html:
            desk.intro("What is moving?", "Changes among items with enough recent sales to support a comparison.") +
            html`
                <div class="sectionGap row">
                    <div class="segmented">
                        ${["1D", "7D", "30D"]
                            .map(
                                (w) => html`
                                    <button data-window="${w}" class="${window === w ? "on" : ""}">${w}</button>
                                `,
                            )
                            .join("")}
                    </div>
                </div>
                <div class="equal">
                    <section class="panel">
                        <div class="panelHead">
                            <h3 class="positive">&#8593; Rising</h3>
                        </div>
                        ${list(m.gainers)}
                    </section>
                    <section class="panel">
                        <div class="panelHead">
                            <h3 class="negative">&#8595; Falling</h3>
                        </div>
                        ${list(m.losers)}
                    </section>
                </div>
            `,
    };
}
