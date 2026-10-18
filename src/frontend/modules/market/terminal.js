import marketApi from "./api.js";
import { RARITIES, formatAge, formatPercent } from "./types.js";
import { TYPE_NAMES, esc, money, change, evidenceLabel, activityLabel, identity, empty, stat } from "./presentation.js";
import { readWatchlist, saveWatchlist, toggleWatch } from "./watchlist.js";
import MarketChart from "./chart.js";
import { itemDesk, marketDesk } from "./analytics.js";
import ItemSearch, { itemSearch } from "./itemSearch.js";

const MINUTE = 60_000;
const PREF_KEY = "kute_market_advanced";
const RANGES = ["1D", "7D", "1M", "3M", "1Y", "ALL"];
const TITLES = { overview: "Market", search: "Discover", active: "Discover", movers: "Discover", deals: "Discover", indices: "Market", watchlist: "Watchlist", portfolio: "Inventory", analyze: "Trade", help: "How it works", item: "Item overview" };
const DISCOVERY_TABS = ["search", "active", "deals", "movers"];

/**
 * @typedef {{q:string,rarity:string,type:string,sort:string,page:number,budget:string,minSales:string}} SearchState
 * @typedef {{skin:number,range:string,candles:boolean,overlay:string,zoom:number,offset:number,price?:string,quantity?:string,listingMax?:string,serialMax?:string,wearMax?:string,ageMax?:string,sellerMax?:string}} ItemState
 * @typedef {{html:string,asOf?:number,asOfLabel?:string,points?:import("./chart.js").ChartPoint[],series?:import("./chart.js").Series[],chartOptions?:{candles?:boolean,volume?:boolean,zoom?:number,stepMs?:number,offset?:number},item?:import("./types.js").ItemPage,listings?:import("./types.js").ListingsReply|null,holdings?:import("./types.js").PortfolioItem[]}} View
 */

const defaultSearch = () => ({ q: "", rarity: "", type: "", sort: "volume", page: 1, budget: "", minSales: "" });

class Terminal {
    constructor(){
        /** @type {HTMLDivElement|null} */
        this.overlay = null;
        /** @type {ShadowRoot|null} */
        this.shadow = null;
        /** @type {AbortController|null} */
        this.controller = null;
        /** @type {MarketChart|null} */
        this.chart = null;
        /** @type {HTMLElement|null} */
        this.returnFocus = null;
        this.tab = "overview";
        this.discoveryTab = "search";
        /** @type {unknown} */
        this.arg = undefined;
        this.generation = 0;
        this.advanced = false;
        /** @type {View|null} */
        this.view = null;
        /** @type {Map<string,{arg:unknown,scroll:number}>} */
        this.saved = new Map();
        this.previous = "search";
        this.portfolioFilter = "";
        /** @type {ItemSearch|null} */
        this.itemSearch = null;
        /** @type {import("./types.js").PortfolioItem[]} */
        this.holdings = [];
        this.tradeRevision = 0;
        this.analyzer = { give: /** @type {(import("./itemSearch.js").SearchItem & {count:number})[]} */ ([]), get: /** @type {(import("./itemSearch.js").SearchItem & {count:number})[]} */ ([]), giveKr: 0, getKr: 0 };
        try {
            this.advanced = localStorage.getItem(PREF_KEY) === "1";
        }
        catch {
            this.advanced = false;
        }
    }

    /** @param {string} [tab] @param {unknown} [arg] */
    async open(tab, arg){
        if (document.pointerLockElement) return;
        if (!this.overlay){
            const html = await import("../../components/market.html").catch(() => null);
            if (!html || document.pointerLockElement) return;
            if (this.overlay){ await this.show(tab ?? this.tab, arg); return; }
            this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const overlay = document.createElement("div");
            overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:rgba(7,8,13,.78)";
            const host = document.createElement("div");
            overlay.append(host);
            this.shadow = host.attachShadow({ mode: "open" });
            this.shadow.innerHTML = html.default;
            this.overlay = overlay;
            this.controller = new AbortController();
            const { signal } = this.controller;
            document.body.append(overlay);
            this.itemSearch = new ItemSearch(this.shadow, signal, (item, context) => this.selectItem(item, context), (q, context) => this.show(context === "discover" ? this.searchTab() : "search", { ...(context === "discover" ? this.readFilters(1) : defaultSearch()), q, page: 1 }), () => this.holdings);
            this.shadow.addEventListener("click", (event) => this.click(event), { signal });
            this.shadow.addEventListener("change", (event) => this.changed(event), { signal });
            this.shadow.addEventListener("input", (event) => this.input(event), { signal });
            this.shadow.querySelector("#kmSearchForm")?.addEventListener("submit", (event) => {
                event.preventDefault();
                this.show("search", { ...defaultSearch(), q: this.value("#kmGlobalSearch") });
            }, { signal });
            overlay.addEventListener("click", (event) => { if (event.target === overlay) this.close(); }, { signal });
            document.addEventListener("pointerlockchange", () => { if (document.pointerLockElement) this.close(); }, { signal });
            document.addEventListener("keydown", (event) => this.key(event), { signal, capture: true });
            const mode = /** @type {HTMLInputElement} */ (this.shadow.querySelector("#kmAdvanced"));
            mode.checked = this.advanced;
            /** @type {HTMLInputElement|null} */ (this.shadow.querySelector("#kmGlobalSearch"))?.focus();
        }
        await this.show(tab ?? this.tab, arg);
    }

    close(){
        this.remember();
        this.controller?.abort();
        this.controller = null;
        this.itemSearch = null;
        this.chart?.destroy();
        this.chart = null;
        this.overlay?.remove();
        this.overlay = null;
        this.shadow = null;
        this.generation++;
        this.returnFocus?.focus({ preventScroll: true });
    }

    remember(){
        const body = this.shadow?.querySelector("#kmBody");
        if (this.tab === "item") this.arg = this.itemState();
        if ((this.tab === "search" || this.tab === "active") && this.shadow?.querySelector("#kmQ")) this.arg = this.readFilters(this.searchState().page);
        if (this.tab === "deals" && this.shadow?.querySelector("#kmDealBudget")) this.arg = { budget: this.value("#kmDealBudget") };
        if (body) this.saved.set(this.tab, { arg: this.arg, scroll: body.scrollTop });
    }

    /** @param {string} selector */
    value(selector){
        return /** @type {HTMLInputElement|HTMLSelectElement|null} */ (this.shadow?.querySelector(selector))?.value ?? "";
    }

    /** @return {SearchState} */
    searchState(){
        const state = { ...defaultSearch(), ...(this.tab === "active" ? { minSales: "5", sort: "liquidity" } : {}), ...(typeof this.arg === "object" && this.arg ? this.arg : {}) };
        if (this.tab === "active") state.minSales = String(Math.max(5, Number(state.minSales) || 5));
        return state;
    }

    searchTab(){
        return this.tab === "active" ? "active" : "search";
    }

    /** @return {ItemState} */
    itemState(){
        const state = { skin: typeof this.arg === "number" ? this.arg : 0, range: "1M", candles: false, overlay: "none", zoom: 1, offset: 0, ...(typeof this.arg === "object" && this.arg ? this.arg : {}) };
        if (this.view?.item?.skin.skin === state.skin){
            for (const [key, id] of Object.entries({ price: "kmSellPrice", quantity: "kmSellQuantity", listingMax: "kmListingMax", serialMax: "kmSerialMax", wearMax: "kmWearMax", ageMax: "kmAgeMax", sellerMax: "kmSellerMax" })){
                if (this.shadow?.querySelector("#" + id)) Object.assign(state, { [key]: this.value("#" + id) });
            }
        }
        return state;
    }

    /** @param {string} tab @param {unknown} [arg] @param {boolean} [keepScroll] */
    async show(tab, arg, keepScroll = false){
        if (!this.shadow) return;
        this.remember();
        if (tab === "item" && this.tab !== "item") this.previous = this.tab;
        const previousScroll = this.saved.get(this.tab)?.scroll ?? 0;
        const stored = this.saved.get(tab);
        this.tab = tab;
        this.arg = arg === undefined ? stored?.arg : arg;
        const generation = ++this.generation;
        this.itemSearch?.dismiss();
        this.chart?.destroy();
        this.chart = null;
        const body = /** @type {HTMLElement} */ (this.shadow.querySelector("#kmBody"));
        const discovery = DISCOVERY_TABS.includes(tab);
        if (discovery) this.discoveryTab = tab;
        const tabs = /** @type {HTMLElement} */ (this.shadow.querySelector("#kmDiscoverTabs"));
        tabs.hidden = !discovery;
        for (const button of tabs.querySelectorAll("button")){
            const selected = button.dataset.discover === tab;
            button.setAttribute("aria-selected", String(selected));
            button.tabIndex = selected ? 0 : -1;
        }
        if (discovery){
            body.setAttribute("role", "tabpanel");
            body.setAttribute("aria-labelledby", `kmDiscover-${tab}`);
        }
        else {
            body.removeAttribute("role");
            body.removeAttribute("aria-labelledby");
        }
        body.setAttribute("aria-busy", "true");
        body.innerHTML = empty("Loading market data", "Fetching the latest available observations.");
        const title = this.shadow.querySelector("#kmTitle");
        if (title) title.textContent = TITLES[/** @type {keyof typeof TITLES} */ (tab)] ?? "Market";
        let nav = tab === "item" ? this.previous : tab;
        if (DISCOVERY_TABS.includes(nav)) nav = "search";
        if (nav === "indices") nav = "overview";
        for (const el of this.shadow.querySelectorAll("[data-nav]")){
            const active = /** @type {HTMLElement} */ (el).dataset.nav === nav;
            el.classList.toggle("on", active);
            if (active) el.setAttribute("aria-current", "page");
            else el.removeAttribute("aria-current");
        }
        this.updateWatchCount();
        try {
            const view = await this.render(tab);
            if (generation !== this.generation || !this.shadow) return;
            this.view = view;
            this.holdings = view.holdings ?? [];
            body.innerHTML = view.html;
            body.scrollTop = arg === undefined ? stored?.scroll ?? 0 : 0;
            if (keepScroll) body.scrollTop = previousScroll;
            const foot = this.shadow.querySelector("#kmFootRight");
            if (foot) foot.textContent = view.asOf ? `${view.asOfLabel ?? "Estimates calculated"} ${formatAge(Math.max(0, Date.now() - view.asOf))} ago` : "Estimates from observed market data";
            const host = /** @type {HTMLElement|null} */ (body.querySelector(".chart"));
            if (host && view.points && view.series) this.chart = new MarketChart(host, view.points, view.series, view.chartOptions);
            if (tab === "portfolio") this.filterHoldings();
            if (tab === "item"){
                const state = /** @type {ItemState} */ (this.arg);
                for (const [key, id] of Object.entries({ price: "kmSellPrice", quantity: "kmSellQuantity", listingMax: "kmListingMax", serialMax: "kmSerialMax", wearMax: "kmWearMax", ageMax: "kmAgeMax", sellerMax: "kmSellerMax" })){
                    const input = /** @type {HTMLInputElement|null} */ (body.querySelector("#" + id));
                    const value = state?.[/** @type {keyof ItemState} */ (key)];
                    if (input && typeof value === "string") input.value = value;
                }
                this.updatePlanner();
                this.filterListings();
            }
        }
        catch {
            if (generation !== this.generation) return;
            body.innerHTML = empty("Market data is unavailable", "Try again in a moment. Your saved watchlist stays on this device.", '<button class="button" data-action="retry">Try again</button>');
        }
        finally {
            if (generation === this.generation) body.setAttribute("aria-busy", "false");
        }
    }

    updateWatchCount(){
        const counter = this.shadow?.querySelector("#kmWatchCount");
        if (counter) counter.textContent = String(readWatchlist().length);
    }

    /** @param {string} tab @return {Promise<View>} */
    async render(tab){
        switch (tab){
            case "overview": return this.overview();
            case "search": return this.search();
            case "active": return this.search();
            case "item": return this.item();
            case "watchlist": return this.watchlist();
            case "movers": return this.movers();
            case "deals": return this.deals();
            case "indices": return this.indices();
            case "portfolio": return this.portfolio();
            case "analyze": return this.analyze();
            default: return this.help();
        }
    }

    /** @return {View} */
    unavailable(){
        return { html: empty("Market data is unavailable", marketApi.lastError || "The market server could not be reached. Try again in a moment.", '<button class="button" data-action="retry">Try again</button>') };
    }

    /** @param {string} title @param {string} subtitle @param {string} [actions] */
    intro(title, subtitle, actions = ""){
        return `<div class="pageIntro"><div><h1>${esc(title)}</h1><p class="sub">${esc(subtitle)}</p></div>${actions}</div>`;
    }

    /** @param {import("./types.js").SkinSummary[]} items */
    table(items){
        if (!items.length) return empty("No matching items", "Try a wider budget or fewer filters.");
        return `<div class="tableWrap"><table><thead><tr><th>Item</th><th class="num">Kute estimate</th><th class="num">Lowest ask</th><th class="num">7D change</th><th>Activity</th>${this.advanced ? '<th class="num">Listed</th><th>Evidence</th>' : ""}</tr></thead><tbody>${items.map((s) => `<tr class="clickable" data-skin="${s.skin}" tabindex="0"><td>${identity(s)}</td><td class="num">${money(s.fair)}<small>KR</small></td><td class="num">${s.lowest === null ? "No listings" : money(s.lowest)}<small>${s.lowest !== null && s.fair > 0 ? formatPercent(s.lowest / s.fair - 1) + " vs estimate" : ""}</small></td><td class="num">${change(s.trend7d)}</td><td><span class="tag quiet">${s.sales7d} sold / 7D</span></td>${this.advanced ? `<td class="num">${s.onS}</td><td>${esc(evidenceLabel(s))}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
    }

    /** @param {import("./types.js").SkinSummary[]} items */
    compactList(items){
        return `<div class="list">${items.map((s) => `<button class="listRow" data-skin="${s.skin}">${identity(s)}<span class="listValue">${money(s.fair)} <span class="muted">KR</span><small>${s.sales7d} sold this week</small></span></button>`).join("")}</div>`;
    }

    /** @return {Promise<View>} */
    async overview(){
        /** @type {[import("./types.js").OverviewReply|null,import("./types.js").IndicesReply|null]} */
        const [o, indices] = await Promise.all([marketApi.cached("/market/overview", 5 * MINUTE), marketApi.cached("/market/indices", 60 * MINUTE)]);
        if (!o)return this.unavailable();
        const today = new Date().toISOString().slice(0, 10);
        const completed = o.days.filter((d) => d.day < today);
        const last = completed.at(-1);
        const {breadth} = o;
        const main = indices?.indices.find((i) => i.name === "kute-100");
        const watch = readWatchlist().slice(0, 4);
        const values = watch.length ? await marketApi.values(watch.map((w) => w.skin)) : {};
        const watched = watch.length ? `<div class="list">${watch.map((w) => {
            const v = values[w.skin];
            return `<button class="listRow" data-skin="${w.skin}">${identity(w)}<span class="listValue">${money(v?.lowest)}<small>${w.target && v?.lowest !== null && v?.lowest !== undefined && v.lowest <= w.target ? '<span class="positive">Target reached</span>' : "lowest observed ask"}</small></span></button>`;
        }).join("")}</div>` : empty("Make this market yours", "Watch items to follow their price and set a target.", '<button class="button small" data-action="discover">Find your first item</button>');
        const categories = (o.categories ?? []).slice(0, 6);
        const breadthHtml = breadth?.eligible ? `<div class="breadth"><i style="width:${breadth.rising / breadth.eligible * 100}%;background:#77d9b0"></i><i style="width:${breadth.flat / breadth.eligible * 100}%;background:#686b7d"></i><i style="width:${breadth.falling / breadth.eligible * 100}%;background:#f390a0"></i></div><div class="breadthLabels"><span class="positive">&#8593; ${breadth.rising} rising</span><span class="muted">${breadth.flat} steady</span><span class="negative">&#8595; ${breadth.falling} falling</span></div><p class="sub">${breadth.eligible} of ${money(breadth.total)} tradable items have enough recent sales and a measured 7-day trend.</p>` : '<p class="sub">Market breadth appears when enough recent sales and trend history are available.</p>';
        return {
            asOf: o.asOf, asOfLabel: "Sales history updated",
            html: this.intro("A feel for the market.", "Follow what is trading, find your next item, and keep an eye on your favourites.", '<button class="button" data-nav="indices">Explore indices &#8594;</button>')
                + `<div class="metrics">${stat("Sales / latest completed day", last ? last.sales.toLocaleString() : "Collecting", last ? esc(last.day) + " UTC" : "Awaiting sales history")}${stat("KR traded / same day", last ? money(last.volume) : "Collecting", "Official daily sales aggregates")}${stat("KUTE 100", main ? main.value.toFixed(2) : "Building history", main?.change7d !== null && main?.change7d !== undefined ? change(main.change7d) + " over 7 days" : "Equal-weighted index / base 100")}</div>`
                + (this.advanced ? marketDesk(o) : "")
                + `<div class="split"><section class="panel"><div class="panelHead"><h3>Trading activity</h3><small>Completed days / 30D</small></div><div class="chartLegend"><span><i style="background:#f580b4"></i>KR traded</span></div><div class="chart"></div><p class="chartNote">Today's partial data is excluded. Volume describes activity, not price direction.</p></section><section class="panel"><div class="panelHead"><h3>Market direction</h3><small>7-day breadth</small></div>${breadthHtml}<div style="margin-top:28px"><div class="eyebrow">OBSERVED ON THE MARKET</div><h2>${money(o.listingsLive)} sampled listings</h2><p class="sub">Across ${money(o.skinsListed)} items. An asking price is an offer to sell.</p></div><button class="textButton" style="margin-top:22px" data-nav="movers">See what is moving &#8594;</button></section></div>`
                + `<div class="split"><section class="panel"><div class="panelHead"><h3>Across the categories</h3><small>Median 7D change</small></div>${categories.length ? `<div class="categoryGrid">${categories.map((c) => `<button class="category" data-category="${c.type}"><b>${esc(TYPE_NAMES[c.type] ?? "Other")}</b><strong>${change(c.change)}</strong><small>${c.items} active items &middot; ${money(c.volume)} KR / 30D</small></button>`).join("")}</div><p class="chartNote">Categories need at least three eligible items for a change estimate.</p>` : '<p class="sub">Category comparisons are building as sales history arrives.</p>'}</section><section class="panel"><div class="panelHead"><h3>Your watchlist</h3><button class="textButton" data-nav="watchlist">View all &#8594;</button></div>${watched}</section></div>`
                + `<section class="panel"><div class="panelHead"><h3>Actively traded</h3><button class="textButton" data-action="discover">Discover more &#8594;</button></div>${this.compactList(o.active ?? [])}</section>`,
            points: completed.map((d) => ({ t: Date.parse(d.day + "T00:00:00Z"), values: [d.volume] })),
            series: [{ label: "KR traded", color: "#f580b4" }],
        };
    }

    /** @return {Promise<View>} */
    async search(){
        const state = this.searchState();
        const params = new URLSearchParams({ sort: state.sort, page: String(state.page) });
        for (const [key, value] of Object.entries({ q: state.q, rarity: state.rarity, type: state.type, budget: state.budget, min_sales: state.minSales })) if (value !== "") params.set(key, value);
        /** @type {import("./types.js").SearchReply|null} */
        const result = await marketApi.cached(`/market/search?${params}`, MINUTE);
        if (!result)return this.unavailable();
        const options = (/** @type {string[]} */ names, /** @type {string} */ selected) => names.map((n, i) => `<option value="${i}" ${String(i) === selected ? "selected" : ""}>${esc(n)}</option>`).join("");
        const pages = Math.max(1, Math.ceil(result.total / result.perPage));
        return { asOf: result.asOf, html: this.intro(this.tab === "active" ? "Find items that are trading." : "Find your next item.", this.tab === "active" ? `At least ${state.minSales} reported sales in seven days. Ranked by trading activity by default.` : "Browse by budget, recent activity, or the items you already have in mind.", '<button class="button small" data-action="reset-search">Reset filters</button>')
            + `<form id="kmFilters" class="filterBar">${itemSearch("kmQ", "discover", "Search all items", state.q)}<input id="kmBudget" type="number" min="1" aria-label="Maximum asking price in KR" placeholder="Budget in KR" value="${esc(state.budget)}"><select id="kmType" aria-label="Item type"><option value="">All types</option>${options(TYPE_NAMES, state.type)}</select>${this.advanced ? `<select id="kmRarity" aria-label="Rarity"><option value="">All rarities</option>${options(RARITIES.map((r) => r.name), state.rarity)}</select>` : `<input type="hidden" id="kmRarity" value="${esc(state.rarity)}">`}<select id="kmSales" aria-label="Minimum sales">${this.tab === "active" ? "" : '<option value="">Any activity</option>'}${(this.tab === "active" ? [5, 20] : [1, 5, 20]).map((n) => `<option value="${n}" ${String(n) === state.minSales ? "selected" : ""}>${n}+ sales / 7D</option>`).join("")}</select><select id="kmSort" aria-label="Sort items">${[["volume", "Most traded"], ["value", "Highest value"], ["trend7d", "7D gainers"], ["liquidity", "Most active"], ["name", "Name"]].map(([v, n]) => `<option value="${v}" ${v === state.sort ? "selected" : ""}>${n}</option>`).join("")}</select><button type="button" class="button small" data-action="filters">Apply</button></form>`
            + this.table(result.items) + `<div class="pagination"><span>${money(result.total)} matching items</span><div class="row"><button class="button small" data-page="${state.page - 1}" ${state.page <= 1 ? "disabled" : ""}>Previous</button><span>${state.page} / ${pages}</span><button class="button small" data-page="${state.page + 1}" ${state.page >= pages ? "disabled" : ""}>Next</button></div></div>` };
    }

    /** @return {Promise<View>} */
    async item(){
        const state = this.itemState();
        const historyRange = !state.candles && state.range === "7D" ? "1M" : state.range;
        /** @type {[import("./types.js").ItemPage|null,import("./types.js").HistoryReply|null,import("./types.js").ListingsReply|null]} */
        const [page, history, listings] = await Promise.all([marketApi.cached(`/market/item/${state.skin}`, 5 * MINUTE), marketApi.cached(`/market/item/${state.skin}/history?range=${historyRange}`, 5 * MINUTE), marketApi.cached(`/market/item/${state.skin}/listings`, MINUTE)]);
        if (!page)return this.unavailable();
        const s = page.skin;
        const e = page.evidence;
        const watched = readWatchlist().some((w) => w.skin === s.skin);
        const range = e?.dailyRange;
        const recent = e ? `${e.sales} sales across ${e.days} trading days in 30D` : `${page.liquidity.sales30d} sales in 30 days`;
        const reasons = e?.reasons ?? [recent, `The estimate is based on ${s.method.startsWith("sales") ? "historical sales aggregates" : "limited market evidence"}.`];
        const series = [{ label: history?.resolution === "hour" ? "Lowest observed ask" : "Daily average sale", color: "#f580b4" }];
        if (state.overlay !== "none") series.push({ label: ({ fair: "Kute estimate", lowest: "Lowest observed ask", krunker: "Krunker estimate" })[state.overlay] ?? "Comparison", color: "#87b8f7" });
        const points = (history?.points ?? []).filter((p) => historyRange === state.range || p.t >= Date.now() - 7 * 86_400_000).map((p) => ({ t: p.t, values: [history?.resolution === "hour" ? p.lowest : p.avg, ...(series.length > 1 ? [({ fair: p.fair, lowest: p.lowest, krunker: p.krunker })[state.overlay] ?? null] : [])], volume: history?.resolution === "day" && p.salesObserved !== false ? p.sales : null, ask: p.ask }));
        let chartNote = "Daily average completed-sale prices. Today's point, when present, is incomplete. Gaps mean no sale-price observation.";
        if (history?.resolution === "hour") chartNote = "Intraday history shows sampled asks. Official sales data is daily; individual transaction timing is unavailable.";
        if (state.candles) chartNote = "Candles describe sampled asking prices, including historical quote changes. They are not transaction candles. Unsampled periods remain empty.";
        const visiblePoints = Math.max(8, Math.ceil(points.length / state.zoom));
        const panStep = Math.max(1, Math.floor(visiblePoints / 2));
        const listingRows = (listings?.listings ?? []).slice(0, this.advanced ? 250 : 5);
        const bookAt = listings?.observedAt ?? e?.bookAt;
        const stale = !bookAt || Date.now() - bookAt > 3 * 3_600_000;
        const premiumTable = (/** @type {import("./types.js").InstanceBracket[]} */ brackets) => `<div class="tableWrap"><table><thead><tr><th>Attribute</th><th class="num">Observed instances</th><th>Premium</th></tr></thead><tbody>${brackets.map((b) => `<tr><td>${esc(b.label)}</td><td class="num">${b.count}</td><td>${b.premium === null ? "Not established" : change(b.premium)}</td></tr>`).join("")}</tbody></table></div>`;
        return {
            item: page, listings, asOf: s.valuedAt ?? page.asOf, points: history ? points : undefined, series,
            chartOptions: { candles: state.candles, volume: history?.resolution === "day", zoom: state.zoom, stepMs: history?.resolution === "hour" ? 3_600_000 : 86_400_000, offset: state.offset },
            html: `<button class="textButton" data-action="back">&#8592; Back to ${esc(TITLES[/** @type {keyof typeof TITLES} */ (this.previous)] ?? "Discover")}</button><div class="itemHero"><div class="itemArt">${s.thumbnail ? `<img src="${esc(s.thumbnail)}" alt="${esc(s.name)}">` : "K"}</div><div><div class="eyebrow">${esc(RARITIES[s.rarity]?.name)} &middot; ${esc(TYPE_NAMES[s.type])}${s.season ? ` &middot; Season ${s.season}` : ""}</div><h1>${esc(s.name)}</h1><p class="sub">${esc(activityLabel(s))} <span class="muted">&middot;</span> ${esc(evidenceLabel(s))}</p></div><div class="itemActions"><button class="button ${watched ? "" : "primary"}" data-action="watch">${watched ? "Watching" : "+ Watch item"}</button></div></div>`
                + `<div class="metrics">${stat("Kute estimate", `${money(s.fair)} <span class="unit">KR</span>`, esc(recent))}${stat("Lowest observed ask", s.lowest === null ? "None listed" : `${money(s.lowest)} <span class="unit">KR</span>`, s.spread !== null ? change(s.spread) + ` vs estimate${stale ? " &middot; quote needs updating" : ""}` : "No available quote")}${stat("Sales in the last 7 days", String(s.sales7d), `${s.onS} currently listed &middot; ${money(s.inC)} in circulation`)}</div>`
                + `<section class="panel" style="margin-bottom:20px"><div class="panelHead"><h3>Price history</h3><div class="segmented">${RANGES.map((r) => `<button data-range="${r}" class="${state.range === r ? "on" : ""}">${r}</button>`).join("")}</div></div><div class="row" style="margin-bottom:16px"><div class="segmented"><button data-chart-mode="line" class="${!state.candles ? "on" : ""}">Line</button><button data-chart-mode="candles" class="${state.candles ? "on" : ""}">Ask candles</button></div><label class="field"><span class="srOnly">Chart comparison</span><select id="kmOverlay">${[["none", "No comparison"], ["fair", "Kute estimate"], ["lowest", "Lowest ask"], ["krunker", "Krunker estimate"]].map(([v, n]) => `<option value="${v}" ${state.overlay === v ? "selected" : ""}>${n}</option>`).join("")}</select></label><span class="spacer"></span><button class="button small" data-zoom="${Math.min(8, state.zoom * 2)}" ${state.zoom >= 8 ? "disabled" : ""}>Zoom in</button><button class="button small" data-pan="${Math.min(Math.max(0, points.length - visiblePoints), state.offset + panStep)}" ${state.offset + visiblePoints >= points.length ? "disabled" : ""}>Older</button><button class="button small" data-pan="${Math.max(0, state.offset - panStep)}" ${!state.offset ? "disabled" : ""}>Newer</button><button class="button small" data-zoom="1">Reset</button></div><div class="chartLegend">${state.candles ? '<span><i style="background:#77d9b0"></i>Observed ask OHLC</span>' + series.slice(1).map((line) => `<span><i style="background:${line.color}"></i>${esc(line.label)}</span>`).join("") : series.map((line) => `<span><i style="background:${line.color}"></i>${esc(line.label)}</span>`).join("")}${history?.resolution === "day" ? "<span>Bars: reported sales</span>" : ""}</div><div class="chart">${history ? "" : empty("History unavailable", "Price history could not be loaded. Try again in a moment.", '<button class="button small" data-action="retry">Try again</button>')}</div><p class="chartNote">${history ? chartNote : ""} Dates and times are UTC.</p></section>`
                + (this.advanced ? itemDesk(page) : "")
                + `<div class="equal"><section class="panel"><div class="eyebrow">THE CONTEXT</div><h2>What the data says</h2><ul class="insightList">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></section><section class="panel"><div class="eyebrow">RECENT PRICE RANGE</div><h2>${range ? `${money(range.low)} to ${money(range.high)} KR` : "More trading history needed"}</h2><p class="sub">${range ? "Central range of observed daily average prices over 30 days. This is historical context, not a forecast." : "A useful range needs several completed trading days."}</p>${range ? `<div class="rangeTrack"><i style="left:${Math.max(0, Math.min(100, (s.fair - range.low) / Math.max(1, range.high - range.low) * 100))}%"></i></div><div class="breadthLabels"><span class="muted">${money(range.low)}</span><span class="accent">Current estimate</span><span class="muted">${money(range.high)}</span></div>` : ""}<p class="sub" style="margin-top:18px">Krunker estimate: ${money(s.krunker)} KR${s.floor > 0 ? ` &middot; Game quick-sell value: ${money(s.floor)} KR` : " &middot; Not eligible for quick sell"}</p></section></div>`
                + `<section class="panel" style="margin-bottom:20px"><div class="panelHead"><div><h3>Plan an asking price</h3><p class="sub">Compare your price with the listings already competing for buyers.</p></div><span class="tag quiet">Price comparison</span></div><div class="row"><label class="field">Asking price / KR<input id="kmSellPrice" type="number" min="1" value="${s.lowest ?? s.fair}"></label><label class="field">Quantity<input id="kmSellQuantity" type="number" min="1" max="10000" value="1"></label><div id="kmPlannerResult" style="flex:1;min-width:220px;padding:6px 10px;font-size:12px;color:#b2b4c2"></div></div><p class="chartNote">This comparison does not predict when a listing will sell. Gross proceeds exclude listing fees and assume every unit sells at your ask.</p></section>`
                + `<div class="panelHead"><h3>Available listings</h3><small>${listings ? listings.total : "Unknown total"} reported listed${bookAt ? ` &middot; observed ${formatAge(Date.now() - bookAt)} ago` : " &middot; freshness unknown"}</small></div>${stale ? '<div class="notice">These quotes need a fresh market observation. A listing may have changed or sold since it was last seen.</div>' : ""}${this.advanced ? '<div class="filterBar"><input id="kmListingMax" type="number" min="1" placeholder="Max ask / KR" aria-label="Maximum listing price"><input id="kmSerialMax" type="number" min="1" placeholder="Max serial" aria-label="Maximum serial number"><input id="kmWearMax" type="number" min="0" max="1" step="0.01" placeholder="Max wear" aria-label="Maximum wear"><input id="kmAgeMax" type="number" min="0" step="0.5" placeholder="Max age in days" aria-label="Maximum listing age in days"><input id="kmSellerMax" type="number" min="1" placeholder="Max seller supply" aria-label="Maximum sampled listings from one seller"></div>' : ""}`
                + (listingRows.length ? `<div class="tableWrap"><table><thead><tr><th class="num">Ask / KR</th><th class="num">vs estimate</th><th>Seller</th>${this.advanced ? "<th>Listed for</th><th>Instance</th><th class=\"num\">Seller supply</th>" : ""}</tr></thead><tbody id="kmListingRows">${listingRows.map((l) => `<tr data-price="${l.price}" data-serial="${l.serial ?? ""}" data-wear="${l.wear ?? ""}" data-age="${l.ageMs === null ? "" : Math.max(0, l.ageMs) / 86_400_000}" data-seller-count="${l.sellerListings > 0 ? l.sellerListings : ""}"><td class="num">${money(l.price)}</td><td class="num">${change(l.price / s.fair - 1)}</td><td>${esc(l.seller ?? "Unavailable")}</td>${this.advanced ? `<td class="muted">${l.ageMs === null ? "Unknown" : formatAge(l.ageMs)}</td><td class="muted">${l.serial !== null ? `#${l.serial}` : ""}${l.wear !== null ? ` &middot; wear ${l.wear.toFixed(3)}` : ""}</td><td class="num muted">${l.sellerListings > 0 ? l.sellerListings : "Unknown"}</td>` : ""}</tr>`).join("")}</tbody></table></div><p class="chartNote"><span id="kmListingCount">Showing ${listingRows.length} sampled listings of ${listings?.total ?? "unknown"} reported.</span> Seller supply counts all sampled listings from that seller. ${listings && listings.total > (listings.observedTotal ?? listings.listings.length) ? "The upstream listing sample does not cover the full market." : ""}</p>` : empty("No observed listings", "No quotes are available in the current sample. Watch this item and check back."))
                + (this.advanced && page.depth ? `<details><summary>Order-book sample</summary><div class="metrics" style="margin:16px 0">${stat("Sampled listings", String(page.depth.total), "Observed quotes, not the whole market")}${stat("Median sampled ask", `${money(page.depth.median)} <span class="unit">KR</span>`, "An offer to sell, not a sale price")}${stat("Sampled sellers", String(page.depth.sellers), `${page.depth.maxByOne} listings from the largest sampled seller`)}</div><p>The middle half of sampled asks runs from ${money(page.depth.p25)} to ${money(page.depth.p75)} KR. ${money(page.depth.depthKr)} KR is offered across the sample; this does not measure buyer demand.</p></details>` : "")
                + `<details><summary>Supply and ownership</summary><p>${money(s.inC)} units in circulation. ${s.onS} listed for sale.${page.ownership?.top1Share !== null && page.ownership?.top1Share !== undefined ? ` The top holder owns ${(page.ownership.top1Share * 100).toFixed(1)}% of supply.` : " Top-holder concentration is unknown."}${page.ownership?.top10Share !== null && page.ownership?.top10Share !== undefined ? ` The top ten hold ${(page.ownership.top10Share * 100).toFixed(1)}%.` : ""}${s.noSpin ? " This item is not available from spins; other supply sources may still apply." : ""}</p>${this.advanced && page.ownership?.topOwners.length ? `<div class="tableWrap" style="margin-top:15px"><table><thead><tr><th>Observed top holders</th><th class="num">Units</th></tr></thead><tbody>${page.ownership.topOwners.slice(0, 10).map((owner) => `<tr><td>${esc(owner.name)}</td><td class="num">${money(owner.count)}</td></tr>`).join("")}</tbody></table></div><p>Up to ten holders from the latest cached owner sample. This is not a complete ownership census.</p>` : ""}</details>`
                + (page.instances && this.advanced ? `<details><summary>Instance attributes / ${page.instances.registered} observed</summary><p>The registry may favour low serials and extreme wear. These counts describe observed instances. Sale-based premiums need validated evidence.</p><div class="equal" style="margin-top:15px">${premiumTable(page.instances.serial)}${premiumTable(page.instances.wear)}</div></details>` : ""),
        };
    }

    /** @return {Promise<View>} */
    async watchlist(){
        const watch = readWatchlist();
        const head = this.intro("Your eye on the market.", "Watch prices and set targets. Your list is saved only on this device.", '<button class="button" data-action="discover">+ Find an item</button>');
        if (!watch.length) return { html: head + '<section class="panel">' + empty("Start with something you like", "Open an item and choose Watch item. It will appear here with its latest estimate and asking price.", '<button class="button primary" data-action="discover">Explore items</button>') + "</section>" };
        const values = await marketApi.values(watch.map((w) => w.skin));
        const asOf = Math.min(...Object.values(values).flatMap((v) => v.valuedAt ? [v.valuedAt] : []));
        return { asOf: Number.isFinite(asOf) ? asOf : undefined, html: head + `<div class="tableWrap"><table><thead><tr><th>Item</th><th class="num">Estimate / KR</th><th class="num">Lowest ask</th><th>Target / KR</th><th>Status</th><th></th></tr></thead><tbody>${watch.map((w) => {
            const v = values[w.skin];
            let status = '<span class="tag quiet">Watching</span>';
            if (v && (!v.bookAt || Date.now() - v.bookAt > 3 * 3_600_000)) status = '<span class="tag warn">Quote needs updating</span>';
            if (!v) status = '<span class="tag warn">Data unavailable</span>';
            if (w.target !== null && v?.lowest !== null && v?.lowest !== undefined && v.lowest <= w.target && v.bookAt && Date.now() - v.bookAt <= 3 * 3_600_000) status = '<span class="tag good">At your target</span>';
            return `<tr><td><button data-skin="${w.skin}">${identity(w)}</button></td><td class="num">${money(v?.fair)}</td><td class="num">${money(v?.lowest)}</td><td><input class="watchTarget" type="number" min="1" data-target="${w.skin}" value="${w.target ?? ""}" aria-label="Target price for ${esc(w.name)}" placeholder="Set target"></td><td>${status}</td><td><button class="remove" data-unwatch="${w.skin}" aria-label="Remove ${esc(w.name)} from watchlist">&times;</button></td></tr>`;
        }).join("")}</tbody></table></div><p class="chartNote">Targets compare against the latest observed ask. Check the item page for listing freshness. Target alerts are checked in the menu, never during gameplay.</p>` };
    }

    /** @return {Promise<View>} */
    async movers(){
        const window = typeof this.arg === "string" ? this.arg : "7D";
        /** @type {import("./types.js").MoversReply|null} */
        const m = await marketApi.cached(`/market/movers?window=${window}`, 5 * MINUTE);
        if (!m)return this.unavailable();
        const list = (/** @type {typeof m.gainers} */ rows) => `<div class="list">${rows.slice(0, 10).map((s) => `<button class="listRow" data-skin="${s.skin}">${identity(s)}<span class="listValue">${change(s.change)}<small>${money(s.fair)} KR &middot; ${s.sales7d} sales / 7D</small></span></button>`).join("") || '<p class="sub">No eligible items in this period.</p>'}</div>`;
        return { asOf: m.asOf, html: this.intro("What is moving?", "Changes among items with enough recent sales to support a comparison.") + `<div class="row" style="margin-bottom:20px"><div class="segmented">${["1D", "7D", "30D"].map((w) => `<button data-window="${w}" class="${window === w ? "on" : ""}">${w}</button>`).join("")}</div></div><div class="equal"><section class="panel"><div class="panelHead"><h3 class="positive">&#8593; Rising</h3></div>${list(m.gainers)}</section><section class="panel"><div class="panelHead"><h3 class="negative">&#8595; Falling</h3></div>${list(m.losers)}</section></div>` };
    }

    /** @return {Promise<View>} */
    async deals(){
        const budget = /** @type {{budget?:string}|null} */ (this.arg)?.budget ?? "";
        const filters = `<div class="filterBar"><input id="kmDealBudget" type="number" min="1" value="${esc(budget)}" placeholder="Budget in KR" aria-label="Maximum deal price"><button class="button small" data-action="deal-budget">Apply budget</button></div>`;
        /** @type {import("./types.js").DealsReply|null} */
        const result = await marketApi.cached(`/market/deals?min_grade=C&limit=100&budget=${encodeURIComponent(budget)}`, MINUTE);
        if (!result)return this.unavailable();
        return { asOf: result.asOf, asOfLabel: "Quotes observed", html: this.intro("Worth a closer look.", "Observed asks below a sales-based estimate. Inspect the evidence before deciding.") + filters + (result.deals.length ? `<div class="tableWrap"><table><thead><tr><th>Item</th><th class="num">Ask / KR</th><th class="num">Estimate / KR</th><th class="num">Below estimate</th><th>Sales / 7D</th></tr></thead><tbody>${result.deals.map((d) => `<tr class="clickable" tabindex="0" data-skin="${d.skin}"><td>${identity(d)}</td><td class="num">${money(d.price)}</td><td class="num">${money(d.fair)}</td><td class="num positive">${Math.round(d.discount * 100)}%</td><td><span class="tag quiet">${d.sales7d ?? "Unknown"}</span></td></tr>`).join("")}</tbody></table></div><p class="chartNote">A discount is not a predicted profit. Ranked by discount and recent sales support, using heuristic thresholds. Quotes older than three hours are excluded; availability can still change.</p>` : '<section class="panel">' + empty("No supported candidates right now", "The scanner only includes sales-based estimates with sufficient activity and a meaningful discount. Your watchlist can track specific items in the meantime.", '<button class="button" data-nav="watchlist">Open watchlist</button>') + "</section>") };
    }

    /** @return {Promise<View>} */
    async indices(){
        /** @type {import("./types.js").IndicesReply|null} */
        const result = await marketApi.cached("/market/indices", 60 * MINUTE);
        if (!result)return this.unavailable();
        const selected = result.indices.find((i) => i.name === this.arg) ?? result.indices.find((i) => i.name === "kute-100") ?? result.indices[0];
        return { asOf: result.asOf, html: this.intro("The wider picture.", "Equal-weighted indices of eligible items. Base 100 at launch, rebalanced monthly.", '<button class="button" data-nav="overview">Market overview</button>') + `<section class="panel" style="margin-bottom:20px"><div class="panelHead"><h3>${esc(selected?.name ?? "Index history")}</h3><small>${selected?.members ?? 0} items</small></div><div class="chart"></div><p class="chartNote">A new index starts with one observation. Longer comparisons appear as its history grows.</p></section><div class="tableWrap"><table><thead><tr><th>Index</th><th class="num">Level</th><th class="num">7D</th><th class="num">30D</th><th class="num">Items</th></tr></thead><tbody>${result.indices.map((i) => `<tr class="clickable" tabindex="0" data-index-name="${esc(i.name)}"><td>${esc(i.name)}</td><td class="num">${i.value.toFixed(2)}</td><td class="num">${change(i.change7d)}</td><td class="num">${change(i.change30d)}</td><td class="num">${i.members}</td></tr>`).join("")}</tbody></table></div>`, points: (selected?.series ?? []).map((p) => ({ t: Date.parse(p.day + "T00:00:00Z"), values: [p.value] })), series: [{ label: selected?.name ?? "Index", color: "#f580b4" }] };
    }

    /** @return {Promise<View>} */
    async portfolio(){
        let name = typeof this.arg === "string" ? this.arg : "";
        if (!name){
            try { name = localStorage.getItem("krunker_username") ?? ""; }
            catch { name = ""; }
        }
        const heading = this.intro("Know what you hold.", "A view of today's holdings, their estimated value, and where it is concentrated.");
        const form = `<div class="filterBar"><input id="kmName" aria-label="Inventory username" placeholder="Krunker username" value="${esc(name)}"><button class="button" data-action="inventory">View inventory</button></div>`;
        if (!name) return { html: heading + form + empty("Choose an inventory", "Enter a username to value its public inventory.") };
        /** @type {import("./types.js").PortfolioReply|null} */
        const p = await marketApi.cached(`/market/portfolio?name=${encodeURIComponent(name)}`, 5 * MINUTE);
        if (!p) return { html: heading + form + empty("Inventory is unavailable", "The player may not exist, or their inventory could not be loaded.", '<button class="button" data-action="retry">Try again</button>') };
        const coverage = new Map(p.historyCoverage?.map((r) => [r.day, r]) ?? []);
        const basket = p.historyBasket;
        const historySeries = basket?.series ?? p.series;
        const chartTitle = basket && basket.items < basket.total ? "Price history of covered holdings" : "Today's holdings through time";
        const chartDescription = basket ? `${basket.items} of ${basket.total} item types have continuous price coverage, representing ${Math.round(basket.valueShare * 100)}% of today's estimated value. The chart keeps the same items throughout.` : "Incomplete valuation periods are omitted.";
        const historyPanel = historySeries.length ? `<div class="chart"></div><p class="chartNote">${esc(chartDescription)} Historical prices applied to what you own today; this is not personal profit. Marks expire after 30 days without a new sale.</p>` : '<p class="sub">There is not enough continuous price coverage to chart these holdings yet. Your current estimates are listed below.</p>';

        return { asOf: p.asOf, holdings: p.items, html: heading + form + `<div class="metrics">${stat("Estimated inventory value", `${money(p.totalValue)} <span class="unit">KR</span>`, `${p.items.length} valued item types`)}${stat("In more active items", `${Math.round(p.liquidShare * 100)}<span class="unit">%</span>`, "Share in activity grades A to C")}${stat("Largest two positions", `${Math.round(p.concentration * 100)}<span class="unit">%</span>`, "Of estimated inventory value")}</div>${p.limitedEvidenceItems ? `<div class="notice">${p.limitedEvidenceItems} item types (${money(p.limitedEvidenceValue)} KR of the total) have limited sales evidence or use fallback estimates.</div>` : ""}${p.unvaluedItems ? `<div class="notice">${p.unvaluedItems} item types have no usable valuation and are excluded from the total.</div>` : ""}<section class="panel" style="margin-bottom:20px"><div class="panelHead"><h3>${chartTitle}</h3><small>90 days</small></div>${historyPanel}</section><div class="filterBar">${itemSearch("kmHoldingFilter", "holdings", "Filter your holdings", this.portfolioFilter)}<span class="muted">Largest positions first</span></div><div class="tableWrap"><table><thead><tr><th>Item</th><th class="num">Quantity</th><th class="num">Estimate / KR</th><th class="num">Position / KR</th><th class="num">7D change</th>${this.advanced ? "<th>Activity grade</th>" : ""}</tr></thead><tbody>${p.items.map((i) => `<tr class="clickable" data-skin="${i.skin}" tabindex="0"><td>${identity(i)}</td><td class="num">${i.count}</td><td class="num">${money(i.fair)}</td><td class="num">${money(i.value)}</td><td class="num">${change(i.trend7d)}</td>${this.advanced ? `<td>${i.grade}</td>` : ""}</tr>`).join("")}</tbody></table></div>`, points: historySeries.map((s) => ({ t: Date.parse(s.day + "T00:00:00Z"), values: [!basket && coverage.has(s.day) && coverage.get(s.day)?.priced !== coverage.get(s.day)?.total ? null : s.value] })), series: [{ label: "Covered holdings at historical prices", color: "#f580b4" }] };
    }

    /** @param {import("./itemSearch.js").SearchItem} item @param {string} context */
    async selectItem(item, context){
        if (context !== "give" && context !== "get"){ this.show("item", item.skin); return; }
        const existing = this.analyzer[context].find((i) => i.skin === item.skin);
        if (existing) existing.count = Math.min(10000, existing.count + 1);
        else this.analyzer[context].push({ ...item, count: 1 });
        await this.show("analyze", this.arg, true);
        if (this.tab === "analyze") /** @type {HTMLInputElement|null} */ (this.shadow?.querySelector(`#kmPick${context}`))?.focus({ preventScroll: true });
    }

    /** @return {Promise<View>} */
    async analyze(){
        const { analyzer: a } = this;
        const hasItems = !!(a.give.length || a.get.length || a.giveKr || a.getKr);
        const v = hasItems ? await marketApi.analyze({ give: a.give.map(({ skin, count }) => ({ skin, count })), get: a.get.map(({ skin, count }) => ({ skin, count })), giveKr: a.giveKr, getKr: a.getKr }) : null;
        const side = (/** @type {"give"|"get"} */ which) => {
            const priced = v?.[which];
            const kr = which === "give" ? a.giveKr : a.getKr;
            const unknown = priced?.items.some((i) => i.unknown) ?? false;
            const count = a[which].reduce((sum, i) => sum + i.count, 0);
            let total = hasItems ? "Unavailable" : "0";
            if (priced) total = money(priced.value);
            return `<section class="tradeSide" aria-label="${which === "give" ? "You give" : "You receive"}"><div class="tradeSideHead"><h2>${which === "give" ? "You give" : "You receive"}</h2><span>${count} item${count === 1 ? "" : "s"}</span></div><div class="tradeTotal"><strong>${total} <small>KR</small></strong><span>${unknown ? "Partial estimate. Unvalued items excluded." : "Estimated value, including KR"}</span></div>${itemSearch(`kmPick${which}`, which, "Add an item...")}<div class="tradeItems">${a[which].length ? a[which].map((i, index) => {
                const line = priced?.items.find((l) => l.skin === i.skin);
                const value = line && !line.unknown ? money(line.lineValue) + " KR" : "Value unavailable";
                return `<div class="tradeItem"><button class="remove" data-remove="${index}" data-side="${which}" aria-label="Remove ${esc(i.name)} from ${which === "give" ? "your side" : "their side"}">&times;</button>${identity(i)}<div class="tradeItemValue">${value}<small>${line && !line.unknown ? `${money(line.fair)} KR each` : "Needs more evidence"}</small></div><label class="tradeQuantity">Qty<input type="number" min="1" max="10000" value="${i.count}" data-count="${index}" data-side="${which}" aria-label="Quantity of ${esc(i.name)} on ${which === "give" ? "your side" : "their side"}"></label></div>`;
            }).join("") : '<div class="tradeEmpty"><span>+</span>Add items to this side<small>Search by name above</small></div>'}</div><label class="tradeKr">Additional KR<input type="number" min="0" max="1000000000" data-kr="${which}" value="${kr}"></label></section>`;
        };
        let result = '<div class="tradeComparison muted">Add items or KR to see the difference. Estimates update as you build the trade.</div>';
        if (hasItems && !v) result = '<div class="notice">Analysis unavailable. Your selected items are preserved. <button class="textButton" data-action="analyze">Try again</button></div>';
        if (v){
            const text = { good: "More estimated value coming in", bad: "More estimated value going out", fair: "Similar estimated value", uncertain: "Too little evidence for a verdict" }[v.verdict];
            const color = { good: "positive", bad: "negative", fair: "", uncertain: "" }[v.verdict];
            result = `<div class="tradeComparison"><div><div class="eyebrow">THE DIFFERENCE</div><div class="verdict ${color}">${text}</div><span class="muted">Receiving minus giving, at estimated value</span></div><div class="tradeDifference ${color}"><strong>${v.difference > 0 ? "+" : ""}${money(v.difference)} <small>KR</small></strong>${change(v.differenceShare)}</div></div><ul class="insightList">${v.drivers.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>${this.advanced ? `<details><summary>Heuristic liquidity adjustment</summary><div class="tradeAdjusted"><div><span>You give</span><strong>${money(v.give.liquidValue)} KR</strong></div><div><span>You receive</span><strong>${money(v.get.liquidValue)} KR</strong></div></div><p>After grade and quantity discounts. These are illustrative adjustments, not forecasts of sale proceeds.</p></details>` : ""}`;
        }
        return { asOf: v?.asOf, html: this.intro("Compare the trade.", "Your items on the left, theirs on the right. Add KR to either side.", '<button class="button" data-action="clear-trade">Clear trade</button>') + `<div class="tradeBoard">${side("give")}${side("get")}</div><div id="kmTradeOutcome" aria-live="polite">${result}</div>` };
    }

    async refreshTrade(){
        const { generation } = this;
        const revision = ++this.tradeRevision;
        const outcome = this.shadow?.querySelector("#kmTradeOutcome");
        outcome?.setAttribute("aria-busy", "true");
        const foot = this.shadow?.querySelector("#kmFootRight");
        if (foot) foot.textContent = "Updating trade estimates...";
        const view = await this.analyze();
        if (generation !== this.generation || revision !== this.tradeRevision || !this.shadow) return;
        const fresh = document.createElement("div");
        fresh.innerHTML = view.html;
        // keep editable controls in place when a blur starts the next interaction
        for (const selector of [".tradeSideHead>span", ".tradeTotal", ".tradeItemValue", "#kmTradeOutcome"]){
            const updates = fresh.querySelectorAll(selector);
            this.shadow.querySelectorAll(selector).forEach((el, index) => { if (updates[index]) el.replaceWith(updates[index]); });
        }
        if (foot) foot.textContent = view.asOf ? `Estimates calculated ${formatAge(Math.max(0, Date.now() - view.asOf))} ago` : "Estimates from observed market data";
        this.view = view;
    }

    /** @return {Promise<View>} */
    async help(){
        return { html: this.intro("Understand the estimate.", "What the numbers mean, where they come from, and when to treat them cautiously.") + "<div class=\"prose\"><h2>Prices and evidence</h2><p>The Kute estimate uses recent completed daily sales aggregates, with older history when trading is sparse. It accounts for unusual averages and lower competing asks. When there are no recent sales, the estimate falls back to asking prices, Krunker's estimate, or a game quick-sell value. The item page tells you which evidence is available.</p><p>Recent sales and sparse sales describe the supporting data. A heuristic evidence score is not a probability that a price is correct. Historical price ranges describe daily averages, not every transaction or a prediction interval.</p><h2>Reading the charts</h2><p>Both modes include line and candle charts, comparisons, zoom, pan, and daily sales bars. Line charts show daily average sale prices, except the 1D range which uses observed asks. Ask candles show the open, high, low, and close of sampled quotes, including historical quote changes. Gaps are retained. Volume bars show official daily sale counts where available.</p><h2>Advanced analytics</h2><p>Advanced adds daily-price moving averages, RSI, volatility, drawdown, sales-weighted prices, activity comparisons, and an ask-side depth ladder. These describe completed observations. Moving averages and RSI need consecutive priced days; missing data stays unavailable. Market diagnostics show breadth, return dispersion, category performance, and turnover concentration. Metric explanations and coverage appear alongside the numbers.</p><h2>Activity and selling</h2><p>Activity grades combine historical sales frequency, listed supply, and the relationship between asks and estimated value. They do not promise a selling time. The asking-price planner compares your proposed price with observed competitors; its gross proceeds assume all units sell and exclude listing fees.</p><h2>Trade comparisons</h2><p>A verdict compares the estimated value of the two sides and becomes uncertain when an item cannot be reliably valued. Advanced liquidity adjustments are heuristic discounts, not guaranteed liquidation prices. Rare instance premiums remain unknown until supported by validated sales.</p><h2>Your watchlist and inventory</h2><p>Watchlists, target prices, and your preferred view are stored on this device. Target checks run in the menu and pause during gameplay. Inventory history applies historical prices to today's holdings. It does not measure personal profit.</p><h2>Your data</h2><p>With Kute Market enabled, your completed sales and trades are contributed without player names. Your game login token stays on your PC. Disable Kute Market to stop both contributions and the feature, or disable online features to stop all contact with Kute's server.</p><h2>You make the trade</h2><p>Kute does not buy, list, or trade items for you. Check the source, freshness, and trading activity alongside the estimate. Predictive prices and sale probabilities will only appear when their accuracy has been evaluated.</p></div>" };
    }

    updatePlanner(){
        const output = this.shadow?.querySelector("#kmPlannerResult");
        if (!output || !this.view?.item) return;
        const price = Number(this.value("#kmSellPrice"));
        const quantity = Number(this.value("#kmSellQuantity"));
        if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000){
            output.textContent = "Enter a positive asking price and a quantity from 1 to 10,000.";
            return;
        }
        const list = this.view.listings;
        if (!list){ output.textContent = "Competing listings are unavailable. Try again when market data is available."; return; }
        const cheaper = list?.listings.filter((l) => l.price < price).length ?? 0;
        const incomplete = !!list && list.total > list.listings.length;
        output.innerHTML = `<b>${incomplete ? "At least " : ""}${cheaper} cheaper listing${cheaper === 1 ? "" : "s"}</b> observed${list ? "" : " (listing data unavailable)"}.<br><span class="muted">${money(price * quantity)} KR gross if all ${quantity} sell &middot; ${formatPercent(price / this.view.item.skin.fair - 1)} vs estimate.</span>`;
    }

    filterHoldings(){
        const query = this.portfolioFilter.toLocaleLowerCase().trim();
        for (const row of this.shadow?.querySelectorAll("tr[data-skin]") ?? []){
            const el = /** @type {HTMLElement} */ (row);
            el.hidden = !el.querySelector(".itemIdentity")?.textContent?.toLocaleLowerCase().includes(query);
        }
    }

    filterListings(){
        const max = this.value("#kmListingMax");
        const serial = this.value("#kmSerialMax");
        const wear = this.value("#kmWearMax");
        const age = this.value("#kmAgeMax");
        const seller = this.value("#kmSellerMax");
        for (const row of this.shadow?.querySelectorAll("#kmListingRows tr") ?? []){
            const el = /** @type {HTMLElement} */ (row);
            el.hidden = !!(max && Number(el.dataset.price) > Number(max)) || !!(serial && (!el.dataset.serial || Number(el.dataset.serial) > Number(serial))) || !!(wear && (!el.dataset.wear || Number(el.dataset.wear) > Number(wear))) || !!(age && (!el.dataset.age || Number(el.dataset.age) > Number(age))) || !!(seller && (!el.dataset.sellerCount || Number(el.dataset.sellerCount) > Number(seller)));
        }
        const count = this.shadow?.querySelector("#kmListingCount");
        const rows = [...this.shadow?.querySelectorAll("#kmListingRows tr") ?? []];
        const shown = rows.filter((r) => !/** @type {HTMLElement} */ (r).hidden).length;
        if (count) count.textContent = `${shown} sampled listings shown; ${this.view?.listings?.total ?? "unknown"} reported listed.`;
    }

    /** @param {number} [page] */
    applyFilters(page = 1){
        this.show(this.searchTab(), this.readFilters(page));
    }

    /** @param {number} page @return {SearchState} */
    readFilters(page){
        return { q: this.value("#kmQ").trim(), rarity: this.value("#kmRarity"), type: this.value("#kmType"), sort: this.value("#kmSort"), budget: this.value("#kmBudget"), minSales: this.value("#kmSales"), page };
    }

    /** @param {Event} event */
    click(event){
        const el = event.target instanceof Element ? /** @type {HTMLElement|null} */ (event.target.closest("button,tr[data-skin],tr[data-index-name],tr[data-category]")) : null;
        if (!el || el.hasAttribute("disabled")) return;
        const d = el.dataset;
        if (el.id === "kmClose"){ this.close(); return; }
        if (d.discover){
            if (d.discover === this.tab) return;
            if (d.discover === "deals" && !this.saved.has("deals") && (this.tab === "search" || this.tab === "active")) this.show("deals", { budget: this.value("#kmBudget") });
            else this.show(d.discover);
            return;
        }
        if (d.nav === "search"){ this.show(this.discoveryTab); return; }
        if (d.nav){ this.show(d.nav); return; }
        if (d.skin){ this.show("item", Number(d.skin)); return; }
        if (d.category){ this.show("search", { ...defaultSearch(), type: d.category, minSales: "5" }); return; }
        if (d.page){ this.applyFilters(Number(d.page)); return; }
        if (d.range){ this.show("item", { ...this.itemState(), range: d.range, zoom: 1, offset: 0 }, true); return; }
        if (d.chartMode){ this.show("item", { ...this.itemState(), candles: d.chartMode === "candles" }, true); return; }
        if (d.pan !== undefined){ this.show("item", { ...this.itemState(), offset: Number(d.pan) }, true); return; }
        if (d.zoom){ this.show("item", { ...this.itemState(), zoom: Number(d.zoom), offset: d.zoom === "1" ? 0 : this.itemState().offset }, true); return; }
        if (d.window){ this.show("movers", d.window); return; }
        if (d.indexName){ this.show("indices", d.indexName); return; }
        if (d.unwatch){
            if (!saveWatchlist(readWatchlist().filter((w) => w.skin !== Number(d.unwatch)))){ this.storageError(); return; }
            this.show("watchlist", this.arg, true);
            return;
        }
        if (d.remove !== undefined && d.side){
            this.analyzer[/** @type {"give"|"get"} */ (d.side)].splice(Number(d.remove), 1);
            this.show("analyze", this.arg, true);
            return;
        }
        switch (d.action){
            case "discover": this.show("search", defaultSearch()); break;
            case "reset-search": this.show(this.searchTab(), this.tab === "active" ? { ...defaultSearch(), minSales: "5", sort: "liquidity" } : defaultSearch()); break;
            case "back": this.show(this.previous); break;
            case "retry": this.retry(); break;
            case "filters": this.applyFilters(); break;
            case "deal-budget": this.show("deals", { budget: this.value("#kmDealBudget") }); break;
            case "inventory": this.show("portfolio", this.value("#kmName").trim()); break;
            case "analyze": this.show("analyze", this.arg, true); break;
            case "clear-trade": this.analyzer = { give: [], get: [], giveKr: 0, getKr: 0 }; this.show("analyze"); break;
            case "watch":
                if (this.view?.item){
                    if (!toggleWatch(this.view.item.skin)){ this.storageError(); return; }
                    this.show("item", this.arg, true);
                }
                break;
            default: break;
        }
    }

    storageError(){
        const foot = this.shadow?.querySelector("#kmFootRight");
        if (foot) foot.textContent = "Could not save on this device. The watchlist holds up to 100 items.";
    }

    async retry(){
        const { generation } = this;
        await marketApi.retry();
        if (generation === this.generation) await this.show(this.tab, this.arg);
    }

    /** @param {Event} event */
    changed(event){
        const el = event.target;
        if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
        if (el.id === "kmAdvanced"){
            this.advanced = /** @type {HTMLInputElement} */ (el).checked;
            try { localStorage.setItem(PREF_KEY, this.advanced ? "1" : "0"); }
            catch { this.storageError(); }
            this.show(this.tab, undefined, true);
        }
        else if (el.id === "kmOverlay") this.show("item", { ...this.itemState(), overlay: el.value }, true);
        else if (el.dataset.target){
            const value = Number(el.value);
            const watch = readWatchlist().map((w) => w.skin === Number(el.dataset.target) ? { ...w, target: value > 0 && Number.isFinite(value) ? value : null } : w);
            if (!saveWatchlist(watch)){ this.storageError(); return; }
            this.show("watchlist", this.arg, true);
        }
        else if (el.dataset.count !== undefined && el.dataset.side){
            const item = this.analyzer[/** @type {"give"|"get"} */ (el.dataset.side)][Number(el.dataset.count)];
            if (item){
                item.count = Math.min(10000, Math.max(1, Math.floor(Number(el.value) || 1)));
                el.value = String(item.count);
            }
            this.refreshTrade();
        }
        else if (el.dataset.kr){
            const value = Math.max(0, Math.min(1e9, Math.floor(Number(el.value) || 0)));
            if (el.dataset.kr === "give") this.analyzer.giveKr = value;
            else this.analyzer.getKr = value;
            el.value = String(value);
            this.refreshTrade();
        }
        else if (el.closest("#kmFilters") && el instanceof HTMLSelectElement) this.applyFilters();
    }

    /** @param {Event} event */
    input(event){
        const el = event.target;
        if (!(el instanceof HTMLInputElement)) return;
        if (el.id === "kmSellPrice" || el.id === "kmSellQuantity"){ this.updatePlanner(); return; }
        if (["kmListingMax", "kmSerialMax", "kmWearMax", "kmAgeMax", "kmSellerMax"].includes(el.id)){ this.filterListings(); return; }
        if (el.id === "kmHoldingFilter"){ this.portfolioFilter = el.value; this.filterHoldings(); return; }
    }

    /** @param {KeyboardEvent} event */
    key(event){
        if (!this.shadow) return;
        event.stopImmediatePropagation();
        if (this.itemSearch?.key(event)) return;
        if (event.isComposing) return;
        if (event.key === "Escape"){
            event.stopImmediatePropagation();
            event.preventDefault();
            this.close();
            return;
        }
        const active = /** @type {HTMLElement|null} */ (this.shadow.activeElement);
        if (active?.matches("[data-discover]") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)){
            event.preventDefault();
            const tabs = [...this.shadow.querySelectorAll("#kmDiscoverTabs button")];
            const current = tabs.indexOf(active);
            let next = (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            if (event.key === "Home") next = 0;
            if (event.key === "End") next = tabs.length - 1;
            const button = /** @type {HTMLButtonElement} */ (tabs[next]);
            button.focus();
            button.click();
            return;
        }
        if (event.key === "Enter" && active){
            if (active.closest("#kmFilters")){ event.preventDefault(); this.applyFilters(); }
            else if (active.id === "kmName"){ event.preventDefault(); this.show("portfolio", this.value("#kmName").trim()); }
            else if (active.matches("tr[data-skin],tr[data-index-name],tr[data-category]")){ event.preventDefault(); active.click(); }
        }
        if (event.key !== "Tab") return;
        const focusable = [...this.shadow.querySelectorAll("button:not(:disabled):not([tabindex='-1']),input:not([type=hidden]),select,summary,[tabindex='0']")].filter((e) => e instanceof HTMLElement && e.getClientRects().length && !e.closest("[hidden]"));
        const first = /** @type {HTMLElement|undefined} */ (focusable[0]);
        const last = /** @type {HTMLElement|undefined} */ (focusable.at(-1));
        if (event.shiftKey && (active === first || !active)){ event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (active === last || !active)){ event.preventDefault(); first?.focus(); }
    }
}

const terminal = new Terminal();
export default terminal;
