import { html } from "../element.js";
import marketApi from "../api.js";
import { esc, money, identity, empty, fairValue } from "../presentation.js";
import { readWatchlist, saveWatchlist } from "../watchlist.js";
import alerts from "../alerts.js";
/** @param {import("../terminal.js").Terminal} desk  @return {Promise<import("../terminal.js").View>} */
export async function watchlistView(desk){
    const watch = readWatchlist();
    const head = desk.intro(
        "Your eye on the market.",
        "Watch prices and set targets. Your list is saved only on this device.",
        '<button class="button" data-action="discover">+ Find an item</button>',
    );
    if (!watch.length){
        return {
            html:
                head +
                '<section class="panel">' +
                empty(
                    "Start with something you like",
                    "Open an item and choose Watch item. It will appear here with its latest estimate and asking price.",
                    '<button class="button primary" data-action="discover">Explore items</button>',
                ) +
                "</section>",
        };
    }
    // items watched before the rarity was stored get it once
    const missing = watch.filter((w) => w.rarity === undefined);
    if (missing.length){
        const items = await Promise.all(missing.map((w) => marketApi.cached(`/market/item/${w.skin}`, 300_000)));
        missing.forEach((w, i) => {
            const rarity = items[i]?.skin?.rarity;
            if (Number.isInteger(rarity)) w.rarity = rarity;
        });
        if (missing.some((w) => w.rarity !== undefined)) saveWatchlist(watch);
    }
    const values = await marketApi.values(watch.map((w) => w.skin));
    // the rows below still show what was new, the badge goes
    const unread = new Set(alerts.unread);
    queueMicrotask(() => alerts.markRead());
    const asOf = Math.min(...Object.values(values).flatMap((v) => (v.valuedAt ? [v.valuedAt] : [])));
    return {
        asOf: Number.isFinite(asOf) ? asOf : undefined,
        html:
            head +
            html`
                <div class="tableWrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Item</th>
                                <th class="num">Estimate / KR</th>
                                <th class="num">Lowest ask</th>
                                <th>Target / KR</th>
                                <th>Status</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            ${watch
                                .map((w) => {
                                    const v = values[w.skin];
                                    let status = '<span class="tag quiet">Watching</span>';
                                    if (v && (!v.bookAt || Date.now() - v.bookAt > 3 * 3_600_000)){
                                        status = '<span class="tag warn">Quote needs updating</span>';
                                    }
                                    if (!v) status = '<span class="tag warn">Data unavailable</span>';
                                    if (
                                        w.target !== null &&
                                        v?.lowest !== null &&
                                        v?.lowest !== undefined &&
                                        v.lowest <= w.target &&
                                        v.bookAt &&
                                        Date.now() - v.bookAt <= 3 * 3_600_000
                                    ){
                                        status = '<span class="tag good">At your target</span>';
                                    }
                                    if (unread.has(w.skin)) status = '<span class="tag good">New: price reached</span>';
                                    return html`
                                        <tr>
                                            <td>
                                                <button data-skin="${esc(w.skin)}">${identity(w)}</button>
                                            </td>
                                            <td class="num">${fairValue(v)}</td>
                                            <td class="num">${money(v?.lowest)}</td>
                                            <td>
                                                <input
                                                    class="watchTarget"
                                                    type="number"
                                                    min="1"
                                                    data-target="${esc(w.skin)}"
                                                    value="${w.target ?? ""}"
                                                    aria-label="Target price for ${esc(w.name)}"
                                                    placeholder="Set target"
                                                />
                                            </td>
                                            <td>${status}</td>
                                            <td>
                                                <button
                                                    class="remove"
                                                    data-unwatch="${esc(w.skin)}"
                                                    aria-label="Remove ${esc(w.name)} from watchlist"
                                                >
                                                    &times;
                                                </button>
                                            </td>
                                        </tr>
                                    `;
                                })
                                .join("")}
                        </tbody>
                    </table>
                </div>
                <p class="chartNote">
                    Targets compare against the latest observed ask. Check the item page for listing freshness. Target alerts are checked in
                    the menu, never during gameplay.
                </p>
            `,
    };
}
