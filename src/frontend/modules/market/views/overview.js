import { html } from "../element.js";
import marketApi from "../api.js";
import { TYPE_NAMES, esc, money, change, identity, empty, stat } from "../presentation.js";
import { readWatchlist } from "../watchlist.js";
import { marketDesk } from "../analytics.js";
const MINUTE = 60_000;
/** @param {import("../terminal.js").Terminal} desk  @return {Promise<import("../terminal.js").View>} */
export async function overviewView(desk){
    /** @type {[import("../types.js").OverviewReply|null,import("../types.js").IndicesReply|null]} */
    const [o, indices] = await Promise.all([
        marketApi.cached("/market/overview", 5 * MINUTE),
        marketApi.cached("/market/indices", 60 * MINUTE),
    ]);
    if (!o) return desk.unavailable();
    const today = new Date().toISOString().slice(0, 10);
    const completed = o.days.filter((d) => d.day < today);
    const last = completed.at(-1);
    const { breadth } = o;
    const main = indices?.indices.find((i) => i.name === "kute-100");
    const watch = readWatchlist().slice(0, 4);
    const values = watch.length ? await marketApi.values(watch.map((w) => w.skin)) : {};
    const watched = watch.length
        ? html`
              <div class="list">
                  ${watch
                      .map((w) => {
                          const v = values[w.skin];
                          return html`
                              <button class="listRow" data-skin="${esc(w.skin)}">
                                  ${identity(w)}
                                  <span class="listValue">
                                      ${money(v?.lowest)}
                                      <small>
                                          ${w.target && v?.lowest !== null && v?.lowest !== undefined && v.lowest <= w.target
                                              ? '<span class="positive">Target reached</span>'
                                              : "lowest observed ask"}
                                      </small>
                                  </span>
                              </button>
                          `;
                      })
                      .join("")}
              </div>
          `
        : empty(
            "Make this market yours",
            "Watch items to follow their price and set a target.",
            '<button class="button small" data-action="discover">Find your first item</button>',
        );
    const categories = (o.categories ?? []).slice(0, 6);
    const breadthHtml = breadth?.eligible
        ? html`
              <div class="breadth">
                  <i style="width:${(breadth.rising / breadth.eligible) * 100}%" class="breadthRising"></i>
                  <i style="width:${(breadth.flat / breadth.eligible) * 100}%" class="breadthFlat"></i>
                  <i style="width:${(breadth.falling / breadth.eligible) * 100}%" class="breadthFalling"></i>
              </div>
              <div class="breadthLabels">
                  <span class="positive">&#8593; ${breadth.rising} rising</span>
                  <span class="muted">${breadth.flat} steady</span>
                  <span class="negative">&#8595; ${breadth.falling} falling</span>
              </div>
              <p class="sub">
                  ${breadth.eligible} of ${money(breadth.total)} tradable items have enough recent sales and a measured 7-day trend.
              </p>
          `
        : '<p class="sub">Market breadth appears when enough recent sales and trend history are available.</p>';
    return {
        asOf: o.asOf,
        asOfLabel: "Sales history updated",
        html:
            desk.intro(
                "A feel for the market.",
                "Follow what is trading, find your next item, and keep an eye on your favourites.",
                '<button class="button" data-nav="indices">Explore indices &#8594;</button>',
            ) +
            html`
                <div class="metrics">
                    ${stat(
                        "Sales / latest completed day",
                        last ? last.sales.toLocaleString() : "Collecting",
                        last ? esc(last.day) + " UTC" : "Awaiting sales history",
                    )}${stat("KR traded / same day", last ? money(last.volume) : "Collecting", "Official daily sales aggregates")}${stat(
                        "KUTE 100",
                        main ? main.value.toFixed(2) : "Building history",
                        main?.change7d !== null && main?.change7d !== undefined
                            ? change(main.change7d) + " over 7 days"
                            : "Equal-weighted index / base 100",
                    )}
                </div>
            ` +
            (desk.advanced ? marketDesk(o) : "") +
            html`
                <div class="split">
                    <section class="panel">
                        <div class="panelHead">
                            <h3>Trading activity</h3>
                            <small>Completed days / 30D</small>
                        </div>
                        <div class="chartLegend">
                            <span>
                                <i class="legendEstimate"></i>
                                KR traded
                            </span>
                        </div>
                        <div class="chart"></div>
                        <p class="chartNote">Today's partial data is excluded. Volume describes activity, not price direction.</p>
                    </section>
                    <section class="panel">
                        <div class="panelHead">
                            <h3>Market direction</h3>
                            <small>7-day breadth</small>
                        </div>
                        ${breadthHtml}
                        <div class="sectionTop">
                            <div class="eyebrow">OBSERVED ON THE MARKET</div>
                            <h2>${money(o.listingsLive)} sampled listings</h2>
                            <p class="sub">Across ${money(o.skinsListed)} items. An asking price is an offer to sell.</p>
                        </div>
                        <button class="sectionTopSmall textButton" data-nav="movers">See what is moving &#8594;</button>
                    </section>
                </div>
            ` +
            html`
                <div class="split">
                    <section class="panel">
                        <div class="panelHead">
                            <h3>Across the categories</h3>
                            <small>Median 7D change</small>
                        </div>
                        ${categories.length
                            ? html`
                                  <div class="categoryGrid">
                                      ${categories
                                          .map(
                                              (c) => html`
                                                  <button class="category" data-category="${c.type}">
                                                      <b>${esc(TYPE_NAMES[c.type] ?? "Other")}</b>
                                                      <strong>${change(c.change)}</strong>
                                                      <small>${c.items} active items &middot; ${money(c.volume)} KR / 30D</small>
                                                  </button>
                                              `,
                                          )
                                          .join("")}
                                  </div>
                                  <p class="chartNote">Categories need at least three eligible items for a change estimate.</p>
                              `
                            : '<p class="sub">Category comparisons are building as sales history arrives.</p>'}
                    </section>
                    <section class="panel">
                        <div class="panelHead">
                            <h3>Your watchlist</h3>
                            <button class="textButton" data-nav="watchlist">View all &#8594;</button>
                        </div>
                        ${watched}
                    </section>
                </div>
            ` +
            html`
                <section class="panel">
                    <div class="panelHead">
                        <h3>Actively traded</h3>
                        <button class="textButton" data-action="discover">Discover more &#8594;</button>
                    </div>
                    ${desk.compactList(o.active ?? [])}
                </section>
            `,
        points: completed.map((d) => ({
            t: Date.parse(d.day + "T00:00:00Z"),
            values: [d.volume],
        })),
        series: [
            {
                label: "KR traded",
                color: "#f580b4",
            },
        ],
    };
}
