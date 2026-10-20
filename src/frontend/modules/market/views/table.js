import { html } from "../element.js";
import { formatPercent } from "../types.js";
import { esc, money, change, evidenceLabel, identity, empty } from "../presentation.js";
/** @param {import("../terminal.js").Terminal} desk  @param {import("../types.js").SkinSummary[]} items */
export function tableView(desk, items){
    if (!items.length) return empty("No matching items", "Try a wider budget or fewer filters.");
    return html`
        <div class="tableWrap">
            <table>
                <thead>
                    <tr>
                        <th>Item</th>
                        <th class="num">Kute estimate</th>
                        <th class="num">Lowest ask</th>
                        <th class="num">7D change</th>
                        <th>Activity</th>
                        ${desk.advanced ? '<th class="num">Listed</th><th>Evidence</th>' : ""}
                    </tr>
                </thead>
                <tbody>
                    ${items
                        .map(
                            (s) => html`
                                <tr class="clickable" data-skin="${esc(s.skin)}" tabindex="0">
                                    <td>${identity(s)}</td>
                                    <td class="num">
                                        ${money(s.fair)}
                                        <small>KR</small>
                                    </td>
                                    <td class="num">
                                        ${s.lowest === null ? "No listings" : money(s.lowest)}
                                        <small>
                                            ${s.lowest !== null && s.fair > 0 ? formatPercent(s.lowest / s.fair - 1) + " vs estimate" : ""}
                                        </small>
                                    </td>
                                    <td class="num">${change(s.trend7d)}</td>
                                    <td>
                                        <span class="tag quiet">${s.sales7d} sold / 7D</span>
                                    </td>
                                    ${desk.advanced
                                        ? html`
                                              <td class="num">${s.onS}</td>
                                              <td>${esc(evidenceLabel(s))}</td>
                                          `
                                        : ""}
                                </tr>
                            `,
                        )
                        .join("")}
                </tbody>
            </table>
        </div>
    `;
}
