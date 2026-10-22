import { html } from "../element.js";
import { esc, identity, fairValue } from "../presentation.js";
/** @param {import("../terminal.js").Terminal} desk  @param {import("../types.js").SkinSummary[]} items */
export function compactListView(desk, items){
    return html`
        <div class="list">
            ${items
                .map(
                    (s) => html`
                        <button class="listRow" data-skin="${esc(s.skin)}">
                            ${identity(s)}
                            <span class="listValue">
                                ${fairValue(s, ' <span class="muted">KR</span>')}
                                <small>${s.sales7d} sold this week</small>
                            </span>
                        </button>
                    `,
                )
                .join("")}
        </div>
    `;
}
