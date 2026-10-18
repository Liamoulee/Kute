import { TITLES, DISCOVERY_TABS } from "./navigation.js";
import { overviewView } from "./views/overview.js";
import { searchView } from "./views/search.js";
import { itemView } from "./views/item.js";
import { watchlistView } from "./views/watchlist.js";
import { moversView } from "./views/movers.js";
import { dealsView } from "./views/deals.js";
import { indicesView } from "./views/indices.js";
import { portfolioView } from "./views/portfolio.js";
import { analyzeView } from "./views/analyze.js";
import { researchView } from "./views/intelligence.js";
import { introView } from "./views/intro.js";
import { tableView } from "./views/table.js";
import { compactListView } from "./views/compactList.js";
import { helpView } from "./views/help.js";
import marketApi from "./api.js";
import { formatAge, formatPercent } from "./types.js";
import { money, empty } from "./presentation.js";
import { readWatchlist, saveWatchlist, toggleWatch } from "./watchlist.js";
import MarketChart from "./chart.js";
import ItemSearch from "./itemSearch.js";
const PREF_KEY = "kute_market_advanced";


/**
 * @typedef {{q:string,rarity:string,type:string,sort:string,page:number,budget:string,minSales:string}} SearchState
 * @typedef {{skin:number,range:string,candles:boolean,overlay:string,zoom:number,offset:number,price?:string,quantity?:string,listingMax?:string,serialMax?:string,wearMax?:string,ageMax?:string,sellerMax?:string}} ItemState
 * @typedef {{html:string,asOf?:number,asOfLabel?:string,points?:import("./chart.js").ChartPoint[],series?:import("./chart.js").Series[],chartOptions?:{candles?:boolean,volume?:boolean,zoom?:number,stepMs?:number,offset?:number},item?:import("./types.js").ItemPage,listings?:import("./types.js").ListingsReply|null,holdings?:import("./types.js").PortfolioItem[]}} View
 */

const defaultSearch = () => ({
    q: "",
    rarity: "",
    type: "",
    sort: "volume",
    page: 1,
    budget: "",
    minSales: "",
});
export class Terminal {
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
        this.analyzer = {
            give: /** @type {(import("./itemSearch.js").SearchItem & {count:number})[]} */([]),
            get: /** @type {(import("./itemSearch.js").SearchItem & {count:number})[]} */([]),
            giveKr: 0,
            getKr: 0,
        };
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
            if (this.overlay){
                await this.show(tab ?? this.tab, arg);
                return;
            }
            this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const overlay = document.createElement("div");
            overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:rgba(7,8,13,.78)";
            const host = document.createElement("div");
            overlay.append(host);
            this.shadow = host.attachShadow({
                mode: "open",
            });
            this.shadow.innerHTML = html.default;
            this.overlay = overlay;
            this.controller = new AbortController();
            const {
                signal,
            } = this.controller;
            document.body.append(overlay);
            this.itemSearch = new ItemSearch(this.shadow, signal, (item, context) => this.selectItem(item, context), (q, context) => this.show(context === "discover" ? this.searchTab() : "search", {
                ...(context === "discover" ? this.readFilters(1) : defaultSearch()),
                q,
                page: 1,
            }), () => this.holdings);
            this.shadow.addEventListener("click", event => this.click(event), {
                signal,
            });
            this.shadow.addEventListener("change", event => this.changed(event), {
                signal,
            });
            this.shadow.addEventListener("input", event => this.input(event), {
                signal,
            });
            this.shadow.querySelector("#kmSearchForm")?.addEventListener("submit", event => {
                event.preventDefault();
                this.show("search", {
                    ...defaultSearch(),
                    q: this.value("#kmGlobalSearch"),
                });
            }, {
                signal,
            });
            overlay.addEventListener("click", event => {
                if (event.target === overlay) this.close();
            }, {
                signal,
            });
            document.addEventListener("pointerlockchange", () => {
                if (document.pointerLockElement) this.close();
            }, {
                signal,
            });
            document.addEventListener("keydown", event => this.key(event), {
                signal,
                capture: true,
            });
            const mode = /** @type {HTMLInputElement} */(this.shadow.querySelector("#kmAdvanced"));
            mode.checked = this.advanced;
            /** @type {HTMLInputElement|null} */
            (this.shadow.querySelector("#kmGlobalSearch"))?.focus();
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
        this.returnFocus?.focus({
            preventScroll: true,
        });
    }
    remember(){
        const body = this.shadow?.querySelector("#kmBody");
        if (this.tab === "item") this.arg = this.itemState();
        if ((this.tab === "search" || this.tab === "active") && this.shadow?.querySelector("#kmQ")) this.arg = this.readFilters(this.searchState().page);
        if (this.tab === "deals" && this.shadow?.querySelector("#kmDealBudget")){
            this.arg = {
                budget: this.value("#kmDealBudget"),
            };
        }
        if (body){
            this.saved.set(this.tab, {
                arg: this.arg,
                scroll: body.scrollTop,
            });
        }
    }

    /** @param {string} selector */
    value(selector){
        return /** @type {HTMLInputElement|HTMLSelectElement|null} */(this.shadow?.querySelector(selector))?.value ?? "";
    }

    /** @return {SearchState} */
    searchState(){
        const state = {
            ...defaultSearch(),
            ...(this.tab === "active" ? {
                minSales: "5",
                sort: "liquidity",
            } : {}),
            ...(typeof this.arg === "object" && this.arg ? this.arg : {}),
        };
        if (this.tab === "active") state.minSales = String(Math.max(5, Number(state.minSales) || 5));
        return state;
    }
    searchTab(){
        return this.tab === "active" ? "active" : "search";
    }

    /** @return {ItemState} */
    itemState(){
        const state = {
            skin: typeof this.arg === "number" ? this.arg : 0,
            range: "1M",
            candles: false,
            overlay: "none",
            zoom: 1,
            offset: 0,
            ...(typeof this.arg === "object" && this.arg ? this.arg : {}),
        };
        if (this.view?.item?.skin.skin === state.skin){
            for (const [key, id] of Object.entries({
                price: "kmSellPrice",
                quantity: "kmSellQuantity",
                listingMax: "kmListingMax",
                serialMax: "kmSerialMax",
                wearMax: "kmWearMax",
                ageMax: "kmAgeMax",
                sellerMax: "kmSellerMax",
            })){
                if (this.shadow?.querySelector("#" + id)){
                    Object.assign(state, {
                        [key]: this.value("#" + id),
                    });
                }
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
        const body = /** @type {HTMLElement} */(this.shadow.querySelector("#kmBody"));
        const discovery = DISCOVERY_TABS.includes(tab);
        if (discovery) this.discoveryTab = tab;
        const tabs = /** @type {HTMLElement} */(this.shadow.querySelector("#kmDiscoverTabs"));
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
        if (title) title.textContent = TITLES[/** @type {keyof typeof TITLES} */(tab)] ?? "Market";
        let nav = tab === "item" ? this.previous : tab;
        if (DISCOVERY_TABS.includes(nav)) nav = "search";
        if (nav === "indices") nav = "overview";
        for (const el of this.shadow.querySelectorAll("[data-nav]")){
            const active = /** @type {HTMLElement} */(el).dataset.nav === nav;
            el.classList.toggle("on", active);
            if (active) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
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
            const host = /** @type {HTMLElement|null} */(body.querySelector(".chart"));
            if (host && view.points && view.series) this.chart = new MarketChart(host, view.points, view.series, view.chartOptions);
            if (tab === "portfolio") this.filterHoldings();
            if (tab === "item"){
                const state = /** @type {ItemState} */(this.arg);
                for (const [key, id] of Object.entries({
                    price: "kmSellPrice",
                    quantity: "kmSellQuantity",
                    listingMax: "kmListingMax",
                    serialMax: "kmSerialMax",
                    wearMax: "kmWearMax",
                    ageMax: "kmAgeMax",
                    sellerMax: "kmSellerMax",
                })){
                    const input = /** @type {HTMLInputElement|null} */(body.querySelector("#" + id));
                    const value = state?.[/** @type {keyof ItemState} */(key)];
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
            case "overview":
                return this.overview();
            case "intelligence":
                return this.intelligence();
            case "search":
                return this.search();
            case "active":
                return this.search();
            case "item":
                return this.item();
            case "watchlist":
                return this.watchlist();
            case "movers":
                return this.movers();
            case "deals":
                return this.deals();
            case "indices":
                return this.indices();
            case "portfolio":
                return this.portfolio();
            case "analyze":
                return this.analyze();
            default:
                return this.help();
        }
    }

    /** @return {Promise<View>} */
    intelligence(){
        return researchView(this);
    }

    /** @return {View} */
    unavailable(){
        return {
            html: empty("Market data is unavailable", marketApi.lastError || "The market server could not be reached. Try again in a moment.", '<button class="button" data-action="retry">Try again</button>'),
        };
    }

    /** @param {string} title @param {string} subtitle @param {string} [actions] */
    intro(title, subtitle, actions = ""){
        return introView(this, title, subtitle, actions);
    }

    /** @param {import("./types.js").SkinSummary[]} items */
    table(items){
        return tableView(this, items);
    }

    /** @param {import("./types.js").SkinSummary[]} items */
    compactList(items){
        return compactListView(this, items);
    }

    /** @return {Promise<View>} */
    overview(){
        return overviewView(this);
    }

    /** @return {Promise<View>} */
    search(){
        return searchView(this);
    }

    /** @return {Promise<View>} */
    item(){
        return itemView(this);
    }

    /** @return {Promise<View>} */
    watchlist(){
        return watchlistView(this);
    }

    /** @return {Promise<View>} */
    movers(){
        return moversView(this);
    }

    /** @return {Promise<View>} */
    deals(){
        return dealsView(this);
    }

    /** @return {Promise<View>} */
    indices(){
        return indicesView(this);
    }

    /** @return {Promise<View>} */
    portfolio(){
        return portfolioView(this);
    }

    /** @param {import("./itemSearch.js").SearchItem} item @param {string} context */
    async selectItem(item, context){
        if (context !== "give" && context !== "get"){
            this.show("item", item.skin);
            return;
        }
        const existing = this.analyzer[context].find(i => i.skin === item.skin);
        if (existing) existing.count = Math.min(10000, existing.count + 1); else {
            this.analyzer[context].push({
                ...item,
                count: 1,
            });
        }
        await this.show("analyze", this.arg, true);
        if (this.tab === "analyze"){
            (/** @type {HTMLInputElement|null} */ (this.shadow?.querySelector(`#kmPick${context}`)))?.focus({
                preventScroll: true,
            });
        }
    }

    /** @return {Promise<View>} */
    analyze(){
        return analyzeView(this);
    }
    async refreshTrade(){
        const {
            generation,
        } = this;
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
            this.shadow.querySelectorAll(selector).forEach((el, index) => {
                if (updates[index]) el.replaceWith(updates[index]);
            });
        }
        if (foot) foot.textContent = view.asOf ? `Estimates calculated ${formatAge(Math.max(0, Date.now() - view.asOf))} ago` : "Estimates from observed market data";
        this.view = view;
    }

    /** @return {View} */
    help(){
        return helpView(this);
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
        if (!list){
            output.textContent = "Competing listings are unavailable. Try again when market data is available.";
            return;
        }
        const cheaper = list?.listings.filter(l => l.price < price).length ?? 0;
        const incomplete = !!list && list.total > list.listings.length;
        output.innerHTML = `<b>${incomplete ? "At least " : ""}${cheaper} cheaper listing${cheaper === 1 ? "" : "s"}</b> observed${list ? "" : " (listing data unavailable)"}.<br>
<span
    class="muted">${money(price * quantity)} KR gross if all ${quantity} sell &middot; ${formatPercent(price / this.view.item.skin.fair - 1)} vs estimate.</span>`;
    }
    filterHoldings(){
        const query = this.portfolioFilter.toLocaleLowerCase().trim();
        for (const row of this.shadow?.querySelectorAll("tr[data-skin]") ?? []){
            const el = /** @type {HTMLElement} */(row);
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
            const el = /** @type {HTMLElement} */(row);
            el.hidden = !!(max && Number(el.dataset.price) > Number(max))
                || !!(serial && (!el.dataset.serial || Number(el.dataset.serial) > Number(serial)))
                || !!(wear && (!el.dataset.wear || Number(el.dataset.wear) > Number(wear)))
                || !!(age && (!el.dataset.age || Number(el.dataset.age) > Number(age)))
                || !!(seller && (!el.dataset.sellerCount || Number(el.dataset.sellerCount) > Number(seller)));
        }
        const count = this.shadow?.querySelector("#kmListingCount");
        const rows = [...(this.shadow?.querySelectorAll("#kmListingRows tr") ?? [])];
        const shown = rows.filter(r => ! /** @type {HTMLElement} */(r).hidden).length;
        if (count) count.textContent = `${shown} sampled listings shown; ${this.view?.listings?.total ?? "unknown"} reported listed.`;
    }

    /** @param {number} [page] */
    applyFilters(page = 1){
        this.show(this.searchTab(), this.readFilters(page));
    }

    /** @param {number} page @return {SearchState} */
    readFilters(page){
        return {
            q: this.value("#kmQ").trim(),
            rarity: this.value("#kmRarity"),
            type: this.value("#kmType"),
            sort: this.value("#kmSort"),
            budget: this.value("#kmBudget"),
            minSales: this.value("#kmSales"),
            page,
        };
    }

    /** @param {Event} event */
    click(event){
        const el = event.target instanceof Element ? /** @type {HTMLElement|null} */(event.target.closest("button,tr[data-skin],tr[data-index-name],tr[data-category]")) : null;
        if (!el || el.hasAttribute("disabled")) return;
        const d = el.dataset;
        if (d.externalUrl){
            event.preventDefault();
            try {
                const url = new URL(d.externalUrl);
                if (url.protocol === "https:" && !url.username && !url.password) window.chrome.webview.postMessage(`open-url, ${url.href}`);
            }
            catch { /* malformed feed links stay inert */ }
            return;
        }
        if (d.intelKind !== undefined){
            this.show("intelligence", d.intelKind);
            return;
        }
        if (el.id === "kmClose"){
            this.close();
            return;
        }
        if (d.discover){
            if (d.discover === this.tab) return;
            if (d.discover === "deals" && !this.saved.has("deals") && (this.tab === "search" || this.tab === "active")){
                this.show("deals", {
                    budget: this.value("#kmBudget"),
                });
            }
            else this.show(d.discover);
            return;
        }
        if (d.nav === "search"){
            this.show(this.discoveryTab);
            return;
        }
        if (d.nav){
            this.show(d.nav);
            return;
        }
        if (d.skin){
            this.show("item", Number(d.skin));
            return;
        }
        if (d.category){
            this.show("search", {
                ...defaultSearch(),
                type: d.category,
                minSales: "5",
            });
            return;
        }
        if (d.page){
            this.applyFilters(Number(d.page));
            return;
        }
        if (d.range){
            this.show("item", {
                ...this.itemState(),
                range: d.range,
                zoom: 1,
                offset: 0,
            }, true);
            return;
        }
        if (d.chartMode){
            this.show("item", {
                ...this.itemState(),
                candles: d.chartMode === "candles",
            }, true);
            return;
        }
        if (d.pan !== undefined){
            this.show("item", {
                ...this.itemState(),
                offset: Number(d.pan),
            }, true);
            return;
        }
        if (d.zoom){
            this.show("item", {
                ...this.itemState(),
                zoom: Number(d.zoom),
                offset: d.zoom === "1" ? 0 : this.itemState().offset,
            }, true);
            return;
        }
        if (d.window){
            this.show("movers", d.window);
            return;
        }
        if (d.indexName){
            this.show("indices", d.indexName);
            return;
        }
        if (d.unwatch){
            if (!saveWatchlist(readWatchlist().filter(w => w.skin !== Number(d.unwatch)))){
                this.storageError();
                return;
            }
            this.show("watchlist", this.arg, true);
            return;
        }
        if (d.remove !== undefined && d.side){
            this.analyzer[/** @type {"give"|"get"} */(d.side)].splice(Number(d.remove), 1);
            this.show("analyze", this.arg, true);
            return;
        }
        switch (d.action){
            case "discover":
                this.show("search", defaultSearch());
                break;
            case "reset-search":
                this.show(this.searchTab(), this.tab === "active" ? {
                    ...defaultSearch(),
                    minSales: "5",
                    sort: "liquidity",
                } : defaultSearch());
                break;
            case "back":
                this.show(this.previous);
                break;
            case "retry":
                this.retry();
                break;
            case "filters":
                this.applyFilters();
                break;
            case "deal-budget":
                this.show("deals", {
                    budget: this.value("#kmDealBudget"),
                });
                break;
            case "inventory":
                this.show("portfolio", this.value("#kmName").trim());
                break;
            case "analyze":
                this.show("analyze", this.arg, true);
                break;
            case "clear-trade":
                this.analyzer = {
                    give: [],
                    get: [],
                    giveKr: 0,
                    getKr: 0,
                };
                this.show("analyze");
                break;
            case "watch":
                if (this.view?.item){
                    if (!toggleWatch(this.view.item.skin)){
                        this.storageError();
                        return;
                    }
                    this.show("item", this.arg, true);
                }
                break;
            default:
                break;
        }
    }
    storageError(){
        const foot = this.shadow?.querySelector("#kmFootRight");
        if (foot) foot.textContent = "Could not save on this device. The watchlist holds up to 100 items.";
    }
    async retry(){
        const {
            generation,
        } = this;
        await marketApi.retry();
        if (generation === this.generation) await this.show(this.tab, this.arg);
    }

    /** @param {Event} event */
    changed(event){
        const el = event.target;
        if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
        if (el.id === "kmAdvanced"){
            this.advanced = /** @type {HTMLInputElement} */(el).checked;
            try {
                localStorage.setItem(PREF_KEY, this.advanced ? "1" : "0");
            }
            catch {
                this.storageError();
            }
            this.show(this.tab, undefined, true);
        }
        else if (el.id === "kmOverlay"){
            this.show("item", {
                ...this.itemState(),
                overlay: el.value,
            }, true);
        }
        else if (el.dataset.target){
            const value = Number(el.value);
            const watch = readWatchlist().map(w => w.skin === Number(el.dataset.target) ? {
                ...w,
                target: value > 0 && Number.isFinite(value) ? value : null,
            } : w);
            if (!saveWatchlist(watch)){
                this.storageError();
                return;
            }
            this.show("watchlist", this.arg, true);
        }
        else if (el.dataset.count !== undefined && el.dataset.side){
            const item = this.analyzer[/** @type {"give"|"get"} */(el.dataset.side)][Number(el.dataset.count)];
            if (item){
                item.count = Math.min(10000, Math.max(1, Math.floor(Number(el.value) || 1)));
                el.value = String(item.count);
            }
            this.refreshTrade();
        }
        else if (el.dataset.kr){
            const value = Math.max(0, Math.min(1e9, Math.floor(Number(el.value) || 0)));
            if (el.dataset.kr === "give") this.analyzer.giveKr = value; else this.analyzer.getKr = value;
            el.value = String(value);
            this.refreshTrade();
        }
        else if (el.closest("#kmFilters") && el instanceof HTMLSelectElement) this.applyFilters();
    }

    /** @param {Event} event */
    input(event){
        const el = event.target;
        if (!(el instanceof HTMLInputElement)) return;
        if (el.id === "kmSellPrice" || el.id === "kmSellQuantity"){
            this.updatePlanner();
            return;
        }
        if (["kmListingMax", "kmSerialMax", "kmWearMax", "kmAgeMax", "kmSellerMax"].includes(el.id)){
            this.filterListings();
            return;
        }
        if (el.id === "kmHoldingFilter"){
            this.portfolioFilter = el.value;
            this.filterHoldings();
            return;
        }
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
        const active = /** @type {HTMLElement|null} */(this.shadow.activeElement);
        if (active?.matches("[data-discover]") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)){
            event.preventDefault();
            const tabs = [...this.shadow.querySelectorAll("#kmDiscoverTabs button")];
            const current = tabs.indexOf(active);
            let next = (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            if (event.key === "Home") next = 0;
            if (event.key === "End") next = tabs.length - 1;
            const button = /** @type {HTMLButtonElement} */(tabs[next]);
            button.focus();
            button.click();
            return;
        }
        if (event.key === "Enter" && active){
            if (active.closest("#kmFilters")){
                event.preventDefault();
                this.applyFilters();
            }
            else if (active.id === "kmName"){
                event.preventDefault();
                this.show("portfolio", this.value("#kmName").trim());
            }
            else if (active.matches("tr[data-skin],tr[data-index-name],tr[data-category]")){
                event.preventDefault();
                active.click();
            }
        }
        if (event.key !== "Tab") return;
        const focusable = [...this.shadow.querySelectorAll("button:not(:disabled):not([tabindex='-1']),input:not([type=hidden]),select,summary,[tabindex='0']")].filter(e => e instanceof HTMLElement && e.getClientRects().length && !e.closest("[hidden]"));
        const first = /** @type {HTMLElement|undefined} */(focusable[0]);
        const last = /** @type {HTMLElement|undefined} */(focusable.at(-1));
        if (event.shiftKey && (active === first || !active)){
            event.preventDefault();
            last?.focus();
        }
        else if (!event.shiftKey && (active === last || !active)){
            event.preventDefault();
            first?.focus();
        }
    }
}
const terminal = new Terminal();
export default terminal;
