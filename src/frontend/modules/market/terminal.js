import { getElement } from "../../utils.js";
import marketApi from "./api.js";
import { GRADE_COLORS, RARITIES, formatAge, formatKr, formatPercent } from "./types.js";

// the terminal: every market view in one overlay behind a shadow root (krunker's css cannot reach it).
// each tab renders from one or two server replies, nothing here polls; a reply is cached by api.js

const MINUTE = 60_000;
const TYPE_NAMES = ["Weapons", "Hats", "Bodies", "Melee", "Sprays", "Dyes", "Waists", "Faces", "Charms", "Emotes", "Stickers", "Skydomes", "Poses", "Spin Tickets", "Capes", "Heads", "Paints", "Backs", "Consumables"];
const RANGES = ["1D", "7D", "1M", "3M", "1Y", "ALL"];

/**
 * @param {string} text
 * @return {string}
 */
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c] ?? c);

/** @param {import("./types.js").Grade} g */
const grade = (g) => `<span class="kmGrade" style="background:${GRADE_COLORS[g]}">${g}</span>`;

/** @param {number|null|undefined} share */
const trend = (share) => {
    if (share === null || share === undefined) return "<span class=\"flat\">–</span>";
    let cls = "flat";
    if (share > 0.005) cls = "up";
    else if (share < -0.005) cls = "down";
    return `<span class="${cls}">${formatPercent(share)}</span>`;
};

/** @param {number} rarity */
const rarityName = (rarity) => `<span style="color:${RARITIES[rarity]?.color ?? "#fff"}">${RARITIES[rarity]?.name ?? "?"}</span>`;

/** @param {import("./types.js").SkinSummary|import("./types.js").Deal|import("./types.js").PortfolioItem} s */
const thumb = (s) => (s.thumbnail ? `<img class="kmThumb" loading="lazy" src="${esc(s.thumbnail)}" alt="">` : "");

/**
 * a line chart with up to three series on one canvas, scaled to the device
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{values: (number|null)[], color: string, label: string}[]} series
 * @param {string[]} labels x labels, one per point
 */
function drawChart(canvas, series, labels){
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 220;
    const scale = window.devicePixelRatio || 1;
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(scale, scale);
    const pad = { l: 56, r: 12, t: 12, b: 24 };
    const all = /** @type {number[]} */ (series.flatMap((s) => s.values).filter((v) => v !== null && Number.isFinite(v)));
    if (!all.length){
        ctx.fillStyle = "#889";
        ctx.font = "13px sans-serif";
        ctx.fillText("no data yet", pad.l, height / 2);
        return;
    }
    const min = Math.min(...all);
    const max = Math.max(...all);
    const span = max - min || Math.max(1, max * 0.1);
    const lo = min - span * 0.08;
    const hi = max + span * 0.08;
    const n = Math.max(2, labels.length);
    const x = (/** @type {number} */ i) => pad.l + (width - pad.l - pad.r) * (i / (n - 1));
    const y = (/** @type {number} */ v) => pad.t + (height - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));
    ctx.strokeStyle = "#2b2d36";
    ctx.fillStyle = "#889";
    ctx.font = "11px sans-serif";
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++){
        const v = lo + (hi - lo) * (g / 4);
        const yy = y(v);
        ctx.beginPath();
        ctx.moveTo(pad.l, yy);
        ctx.lineTo(width - pad.r, yy);
        ctx.stroke();
        ctx.fillText(formatKr(v), 4, yy + 4);
    }
    const step = Math.max(1, Math.ceil(labels.length / 6));
    for (let i = 0; i < labels.length; i += step) ctx.fillText(labels[i], x(i) - 14, height - 6);
    for (const s of series){
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        s.values.forEach((v, i) => {
            if (v === null || !Number.isFinite(v)) return;
            if (!started){
                ctx.moveTo(x(i), y(v));
                started = true;
            }
            else ctx.lineTo(x(i), y(v));
        });
        ctx.stroke();
    }
    let lx = pad.l + 6;
    for (const s of series){
        ctx.fillStyle = s.color;
        ctx.fillRect(lx, pad.t, 10, 3);
        ctx.fillStyle = "#aab";
        ctx.fillText(s.label, lx + 14, pad.t + 5);
        lx += 24 + s.label.length * 6;
    }
}

class Terminal {
    constructor(){
        /** @type {HTMLDivElement|null} */
        this.overlay = null;
        /** @type {ShadowRoot|null} */
        this.shadow = null;
        this.tab = "overview";
        /** @type {unknown} */
        this.arg = undefined;
        /** @type {AbortController|null} */
        this.controller = null;
        /** every render bumps it, a slow reply for an older view is dropped */
        this.generation = 0;
        /** the tab the item view returns to */
        this.previous = "search";
        /** the analyzer's state survives tab switches */
        this.analyzer = { give: /** @type {{skin: number, count: number, name: string}[]} */ ([]), get: /** @type {{skin: number, count: number, name: string}[]} */ ([]), giveKr: 0, getKr: 0 };
    }

    /**
     * @param {string} [tab]
     * @param {unknown} [arg]
     */
    async open(tab, arg){
        if (!this.overlay){
            const html = await import("../../components/market.html");
            const overlay = document.createElement("div");
            overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,.75)";
            const host = document.createElement("div");
            overlay.append(host);
            const shadow = host.attachShadow({ mode: "open" });
            shadow.innerHTML = html.default;
            this.overlay = overlay;
            this.shadow = shadow;
            this.controller = new AbortController();
            const { signal } = this.controller;
            getElement("#kmClose", shadow).addEventListener("click", () => this.close(), { signal });
            overlay.addEventListener("click", (event) => {
                if (event.target === overlay) this.close();
            }, { signal });
            document.addEventListener("keydown", (event) => {
                if (event.key === "Escape"){
                    event.stopPropagation();
                    this.close();
                }
            }, { signal, capture: true });
            for (const button of shadow.querySelectorAll(".kmTab")){
                button.addEventListener("click", () => this.show(/** @type {HTMLElement} */ (button).dataset.tab ?? "overview"), { signal });
            }
            document.body.append(overlay);
        }
        await this.show(tab ?? this.tab, arg);
    }

    close(){
        this.controller?.abort();
        this.controller = null;
        this.overlay?.remove();
        this.overlay = null;
        this.shadow = null;
        this.generation++;
    }

    /**
     * @param {string} tab
     * @param {unknown} [arg]
     */
    async show(tab, arg){
        if (!this.shadow) return;
        this.tab = tab;
        this.arg = arg;
        const generation = ++this.generation;
        for (const button of this.shadow.querySelectorAll(".kmTab")) button.classList.toggle("on", /** @type {HTMLElement} */ (button).dataset.tab === tab);
        const body = getElement("#kmBody", this.shadow);
        body.innerHTML = "<div class=\"kmEmpty\">Loading…</div>";
        const renderers = { overview: () => this.overview(), search: () => this.search(), movers: () => this.movers(), deals: () => this.deals(), indices: () => this.indices(), portfolio: () => this.portfolio(), analyze: () => this.analyze(), item: () => this.item(Number(arg)) };
        const render = renderers[/** @type {keyof typeof renderers} */ (tab)] ?? renderers.overview;
        try {
            const html = await render();
            if (generation !== this.generation || !this.shadow) return;
            body.innerHTML = html;
            this.afterRender(tab);
        }
        catch (error){
            if (generation !== this.generation || !this.shadow) return;
            body.innerHTML = `<div class="kmEmpty">Something went wrong: ${esc(error instanceof Error ? error.message : String(error))}</div>`;
        }
    }

    /**
     * @param {number} asOf
     */
    foot(asOf){
        if (!this.shadow) return;
        const age = Date.now() - asOf;
        getElement("#kmFootRight", this.shadow).textContent = asOf ? `data as of ${age < MINUTE ? "just now" : formatAge(age) + " ago"}` : "";
    }

    /**
     * @return {Promise<string>}
     */
    async fail(){
        return `<div class="kmEmpty">${esc(marketApi.lastError || "Kute Market is not reachable right now")}</div>`;
    }

    /**
     * @param {import("./types.js").SkinSummary[]} items
     * @param {boolean} [withChange]
     * @return {string}
     */
    table(items, withChange = false){
        if (!items.length) return "<div class=\"kmEmpty\">Nothing here</div>";
        const rows = items.map((s) => `<tr class="kmClick" data-skin="${s.skin}">
            <td>${thumb(s)}${esc(s.name)}</td><td>${rarityName(s.rarity)}</td>
            <td class="num">${formatKr(s.fair)}</td><td class="num kmMuted">${s.confidence} %</td><td>${grade(s.grade)}</td>
            <td class="num">${s.lowest === null ? "–" : formatKr(s.lowest)}</td><td class="num">${s.onS}</td>
            <td class="num">${trend(withChange ? /** @type {any} */ (s).change : s.trend7d)}</td><td class="num">${s.sales7d}</td></tr>`).join("");
        return `<table><thead><tr><th>Item</th><th>Rarity</th><th class="num">Fair value</th><th class="num">Conf.</th><th>Liq.</th><th class="num">Lowest ask</th><th class="num">On sale</th><th class="num">${withChange ? "Change" : "7D"}</th><th class="num">Sales 7D</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    async overview(){
        /** @type {import("./types.js").OverviewReply|null} */
        const o = await marketApi.cached("/market/overview", 60 * MINUTE);
        if (!o) return this.fail();
        this.foot(o.asOf);
        const today = o.days.at(-1);
        const bars = (/** @type {number[]} */ shares, /** @type {(i: number) => string} */ label) => `<div class="kmBars">${shares.map((s, i) => `<i style="height:${Math.round(s / Math.max(...shares, 0.0001) * 100)}%" title="${label(i)}: ${(s * 100).toFixed(1)} %"></i>`).join("")}</div>`;
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        return `<div class="kmCards">
            <div class="kmCard"><div class="k">Sales today</div><div class="v">${today ? today.sales.toLocaleString("en-US") : "–"}</div><div class="s">${today ? formatKr(today.volume) + " kr" : ""}</div></div>
            <div class="kmCard"><div class="k">Live listings</div><div class="v">${o.listingsLive.toLocaleString("en-US")}</div><div class="s">${o.skinsListed.toLocaleString("en-US")} skins on the book</div></div>
            <div class="kmCard"><div class="k">KR on the book</div><div class="v">${formatKr(o.krOnBook)}</div><div class="s">sum of every ask</div></div>
        </div>
        <h3>Volume per day, last 30 days</h3><canvas id="kmChart"></canvas>
        <div class="kmGrid2"><div><h3>Sales by hour (UTC)</h3>${bars(o.hours, (i) => `${i}:00`)}</div><div><h3>Sales by weekday</h3>${bars(o.weekdays, (i) => days[i])}<div class="kmMuted" style="font-size:12px">${days.join(" · ")}</div></div></div>`;
    }

    async search(){
        const state = /** @type {{q: string, rarity: string, type: string, sort: string, page: number}} */ (typeof this.arg === "object" && this.arg ? this.arg : { q: "", rarity: "", type: "", sort: "volume", page: 1 });
        const params = new URLSearchParams();
        if (state.q) params.set("q", state.q);
        if (state.rarity !== "") params.set("rarity", state.rarity);
        if (state.type !== "") params.set("type", state.type);
        params.set("sort", state.sort);
        params.set("page", String(state.page));
        /** @type {import("./types.js").SearchReply|null} */
        const reply = await marketApi.cached(`/market/search?${params}`, MINUTE);
        if (!reply) return this.fail();
        this.foot(reply.asOf);
        const options = (/** @type {string[]} */ names, /** @type {string} */ current) => names.map((n, i) => `<option value="${i}" ${String(i) === current ? "selected" : ""}>${n}</option>`).join("");
        const pages = Math.max(1, Math.ceil(reply.total / reply.perPage));
        return `<div class="kmRow">
            <input id="kmQ" placeholder="Search items" value="${esc(state.q)}" style="width:220px">
            <select id="kmRarity"><option value="">Any rarity</option>${options(RARITIES.map((r) => r.name), state.rarity)}</select>
            <select id="kmType"><option value="">Any type</option>${options(TYPE_NAMES, state.type)}</select>
            <select id="kmSort">${["volume", "value", "trend7d", "trend1d", "trend30d", "liquidity", "onsale", "name"].map((s) => `<option value="${s}" ${s === state.sort ? "selected" : ""}>${{ volume: "Most traded", value: "Highest value", trend7d: "7D change", trend1d: "1D change", trend30d: "30D change", liquidity: "Most liquid", onsale: "Most on sale", name: "Name" }[s]}</option>`).join("")}</select>
            <span class="kmMuted">${reply.total.toLocaleString("en-US")} items</span>
            <span style="flex:1"></span>
            <button class="kmBtn" id="kmPrev" ${state.page <= 1 ? "disabled" : ""}>‹</button><span class="kmMuted">${state.page} / ${pages}</span><button class="kmBtn" id="kmNext" ${state.page >= pages ? "disabled" : ""}>›</button>
        </div>${this.table(reply.items)}`;
    }

    async movers(){
        const window = typeof this.arg === "string" ? this.arg : "7D";
        /** @type {import("./types.js").MoversReply|null} */
        const m = await marketApi.cached(`/market/movers?window=${window}`, 5 * MINUTE);
        if (!m) return this.fail();
        this.foot(m.asOf);
        return `<div class="kmRow">${["1D", "7D", "30D"].map((w) => `<button class="kmBtn kmWindow ${w === window ? "on" : ""}" data-window="${w}">${w}</button>`).join("")}<span class="kmMuted">Only items liquid enough that one sale cannot move them</span></div>
            <div class="kmGrid2"><div><h3>Gainers</h3>${this.table(m.gainers, true)}</div><div><h3>Losers</h3>${this.table(m.losers, true)}</div></div>`;
    }

    async deals(){
        const minGrade = typeof this.arg === "string" ? this.arg : "C";
        /** @type {import("./types.js").DealsReply|null} */
        const d = await marketApi.cached(`/market/deals?min_grade=${minGrade}&limit=100`, MINUTE);
        if (!d) return this.fail();
        this.foot(d.asOf);
        const rows = d.deals.map((x) => `<tr class="kmClick" data-skin="${x.skin}"><td>${thumb(x)}${esc(x.name)}</td><td>${rarityName(x.rarity)}</td><td class="num">${formatKr(x.price)}</td><td class="num">${formatKr(x.fair)}</td><td class="num up">-${(x.discount * 100).toFixed(0)} %</td><td>${grade(x.grade)}</td><td class="num kmMuted">${x.confidence} %</td><td>${esc(x.seller ?? "")}</td><td class="num kmMuted">${x.ageMs === null ? "–" : formatAge(x.ageMs)}</td></tr>`).join("");
        return `<div class="kmRow"><label>Liquidity at least</label>${["A", "B", "C", "D"].map((g) => `<button class="kmBtn kmGradeBtn ${g === minGrade ? "on" : ""}" data-grade="${g}">${g}</button>`).join("")}<span class="kmMuted">Listings under Kute's fair value by more than the uncertainty allows. Analytics only.</span></div>
            ${d.deals.length ? `<table><thead><tr><th>Item</th><th>Rarity</th><th class="num">Ask</th><th class="num">Fair value</th><th class="num">Discount</th><th>Liq.</th><th class="num">Conf.</th><th>Seller</th><th class="num">Listed</th></tr></thead><tbody>${rows}</tbody></table>` : "<div class=\"kmEmpty\">No deals right now</div>"}`;
    }

    async indices(){
        /** @type {import("./types.js").IndicesReply|null} */
        const r = await marketApi.cached("/market/indices", 60 * MINUTE);
        if (!r) return this.fail();
        this.foot(r.asOf);
        const rows = r.indices.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${i.value.toFixed(2)}</td><td class="num">${trend(i.change1d)}</td><td class="num">${trend(i.change7d)}</td><td class="num">${trend(i.change30d)}</td><td class="num">${i.members}</td></tr>`).join("");
        return `<p class="kmMuted">Equal weighted on fair value, base 100 at launch, rebalanced monthly. KUTE 100 holds the 100 most traded skins by 30 day volume.</p>
            <canvas id="kmChart"></canvas>
            <table><thead><tr><th>Index</th><th class="num">Value</th><th class="num">1D</th><th class="num">7D</th><th class="num">30D</th><th class="num">Members</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    async portfolio(){
        const name = typeof this.arg === "string" && this.arg ? this.arg : localStorage.getItem("krunker_username") ?? "";
        if (!name) return "<div class=\"kmRow\"><input id=\"kmName\" placeholder=\"Krunker username\"><button class=\"kmBtn\" id=\"kmNameGo\">Show</button></div><div class=\"kmEmpty\">Enter a name</div>";
        /** @type {import("./types.js").PortfolioReply|null} */
        const p = await marketApi.cached(`/market/portfolio?name=${encodeURIComponent(name)}`, 5 * MINUTE);
        const head = `<div class="kmRow"><input id="kmName" placeholder="Krunker username" value="${esc(name)}"><button class="kmBtn" id="kmNameGo">Show</button></div>`;
        if (!p) return head + `<div class="kmEmpty">${esc(marketApi.lastError || "No inventory found for this name")}</div>`;
        this.foot(p.asOf);
        const rows = p.items.slice(0, 200).map((i) => `<tr class="kmClick" data-skin="${i.skin}"><td>${thumb(i)}${esc(i.name)}</td><td>${rarityName(i.rarity)}</td><td class="num">${i.count}</td><td class="num">${formatKr(i.fair)}</td><td class="num">${formatKr(i.value)}</td><td>${grade(i.grade)}</td><td class="num">${trend(i.trend7d)}</td><td class="num">${trend(i.trend30d)}</td></tr>`).join("");
        return `${head}<div class="kmCards">
            <div class="kmCard"><div class="k">Total value</div><div class="v">${formatKr(p.totalValue)}</div><div class="s">${p.items.length} items</div></div>
            <div class="kmCard"><div class="k">Sells quickly</div><div class="v">${formatKr(p.liquidValue)}</div><div class="s">${(p.liquidShare * 100).toFixed(0)} % in grade A to C</div></div>
            <div class="kmCard"><div class="k">Top two items</div><div class="v">${(p.concentration * 100).toFixed(0)} %</div><div class="s">of the value</div></div>
            <div class="kmCard"><div class="k">Best 7D</div><div class="v">${p.best7d ? trend(p.best7d.trend7d) : "–"}</div><div class="s">${esc(p.best7d?.name ?? "")}</div></div>
            <div class="kmCard"><div class="k">Worst 7D</div><div class="v">${p.worst7d ? trend(p.worst7d.trend7d) : "–"}</div><div class="s">${esc(p.worst7d?.name ?? "")}</div></div>
        </div><h3>Value of today's holdings, 90 days</h3><canvas id="kmChart"></canvas>
        <table><thead><tr><th>Item</th><th>Rarity</th><th class="num">Count</th><th class="num">Each</th><th class="num">Value</th><th>Liq.</th><th class="num">7D</th><th class="num">30D</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    /**
     * @param {number} skin
     * @return {Promise<string>}
     */
    async item(skin){
        const range = typeof this.arg === "object" && this.arg && "range" in this.arg ? String(/** @type {any} */ (this.arg).range) : "1M";
        const id = typeof this.arg === "object" && this.arg && "skin" in this.arg ? Number(/** @type {any} */ (this.arg).skin) : skin;
        /** @type {[import("./types.js").ItemPage|null, import("./types.js").HistoryReply|null, import("./types.js").ListingsReply|null]} */
        const [page, history, listings] = await Promise.all([
            marketApi.cached(`/market/item/${id}`, 5 * MINUTE),
            marketApi.cached(`/market/item/${id}/history?range=${range}`, 5 * MINUTE),
            marketApi.cached(`/market/item/${id}/listings`, MINUTE),
        ]);
        if (!page) return `<button class="kmBtn kmBack" id="kmBack">‹ Back</button>${await this.fail()}`;
        this.foot(page.asOf);
        const s = page.skin;
        const l = page.liquidity;
        const rangeBar = (/** @type {import("./types.js").PriceRange} */ r, /** @type {string} */ label) => r.low === null || r.high === null ? "" : `<div class="kmMuted" style="font-size:12px">${label}: ${formatKr(r.low)} to ${formatKr(r.high)} kr</div><div class="kmBar"><i style="width:${Math.round((r.position ?? 0) * 100)}%"></i></div>`;
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const weekdayBars = `<div class="kmBars">${page.weekdays.map((w, i) => `<i style="height:${Math.round(w / Math.max(...page.weekdays, 0.0001) * 100)}%" title="${days[i]}: ${(w * 100).toFixed(0)} %"></i>`).join("")}</div>`;
        const listingRows = (listings?.listings ?? []).slice(0, 15).map((x) => `<tr><td class="num">${formatKr(x.price)}</td><td class="num">${s.fair ? trend(x.price / s.fair - 1) : ""}</td><td>${esc(x.seller ?? "")}${x.sellerListings > 1 ? ` <span class="kmMuted">(${x.sellerListings} up)</span>` : ""}</td><td class="num kmMuted">${x.ageMs === null ? "–" : formatAge(x.ageMs)}</td><td class="kmMuted">${x.serial !== null ? `#${x.serial}` : ""}${x.wear !== null ? ` wear ${x.wear.toFixed(3)}` : ""}</td></tr>`).join("");
        const owners = page.ownership;
        const brackets = (/** @type {import("./types.js").InstanceBracket[]} */ list) => list.map((b) => `<tr><td>${esc(b.label)}</td><td class="num">${b.count}</td><td class="num">${(b.share * 100).toFixed(0)} %</td><td class="num">${b.premium === null ? `<span class="kmMuted">unknown (${b.sales} sales)</span>` : trend(b.premium)}</td></tr>`).join("");
        const method = { sales7d: "sales of the last 7 days", sales30d: "sales of the last 30 days", sales90d: "sales of the last 90 days", ask: "the lowest asks, no recent sale", krunker: "Krunker's estimate, no sales or asks", floor: "the quick sell value, nothing else known" }[s.method] ?? s.method;
        return `<button class="kmBtn kmBack" id="kmBack">‹ Back</button>
        <div class="kmRow" style="align-items:flex-start"><div>${s.thumbnail ? `<img src="${esc(s.thumbnail)}" alt="" style="width:96px;height:96px;object-fit:contain;background:#0f1013;border-radius:8px">` : ""}</div>
            <div style="flex:1"><div style="font-size:22px;font-weight:800">${esc(s.name)} <span style="font-size:13px">${rarityName(s.rarity)} · ${TYPE_NAMES[s.type] ?? "?"}${s.season ? ` · Season ${s.season}` : ""}${s.limType ? ` · ${esc(s.limType)}` : ""}</span></div>
            <div class="kmMuted">Fair value from ${method}. ${s.noSpin ? "Not in spins, fixed supply." : ""} Quick sell floor ${formatKr(s.floor)} kr.</div></div></div>
        <div class="kmCards">
            <div class="kmCard"><div class="k">Fair value</div><div class="v">${formatKr(s.fair)} kr</div><div class="s">${s.confidence} % confidence · Krunker says ${s.krunker === null ? "–" : formatKr(s.krunker)}</div></div>
            <div class="kmCard"><div class="k">Lowest ask</div><div class="v">${s.lowest === null ? "–" : formatKr(s.lowest)}</div><div class="s">${s.spread === null ? "no listings" : trend(s.spread) + " against fair value"}</div></div>
            <div class="kmCard"><div class="k">Liquidity</div><div class="v">${grade(l.grade)} ${l.velocity.toFixed(1)}/day</div><div class="s">${l.sales7d} sales in 7D, ${l.sales30d} in 30D${l.avgTimeToSellMs !== null ? `, sells in ${formatAge(l.avgTimeToSellMs)}` : ""}</div></div>
            <div class="kmCard"><div class="k">Supply</div><div class="v">${s.inC.toLocaleString("en-US")}</div><div class="s">${s.onS} on sale${l.onSaleRatio !== null ? ` (${(l.onSaleRatio * 100).toFixed(2)} %)` : ""}</div></div>
            <div class="kmCard"><div class="k">Trend</div><div class="v">${trend(s.trend7d)}</div><div class="s">7D · 1D ${trend(s.trend1d)} · 30D ${trend(s.trend30d)}</div></div>
        </div>
        <div class="kmRow">${RANGES.map((r) => `<button class="kmBtn kmRange ${r === range ? "on" : ""}" data-range="${r}">${r}</button>`).join("")}</div>
        <canvas id="kmChart"></canvas>
        <div class="kmGrid2">
            <div><h3>Where the price sits</h3>${rangeBar(page.range30, "30 days")}${rangeBar(page.range90, "90 days")}<h3>Sales by weekday</h3>${weekdayBars}</div>
            <div><h3>Depth</h3>${page.depth ? `<div class="kmMuted">${page.depth.total} listings from ${page.depth.sellers} sellers, ${formatKr(page.depth.depthKr)} kr on the book, the biggest seller has ${page.depth.maxByOne}. Asks: lowest ${formatKr(page.depth.lowest ?? 0)}, quarter ${formatKr(page.depth.p25 ?? 0)}, median ${formatKr(page.depth.median ?? 0)}, three quarters ${formatKr(page.depth.p75 ?? 0)}.</div>` : "<div class=\"kmMuted\">No listings</div>"}
            <h3>Ownership</h3>${owners ? `<div class="kmMuted">Top owner holds ${owners.top1Share === null ? "–" : (owners.top1Share * 100).toFixed(1) + " %"}, top 10 ${owners.top10Share === null ? "–" : (owners.top10Share * 100).toFixed(1) + " %"}, top 100 ${owners.top100Share === null ? "–" : (owners.top100Share * 100).toFixed(1) + " %"} of ${owners.inC.toLocaleString("en-US")}.</div><div class="kmMuted" style="font-size:12px;margin-top:4px">${owners.topOwners.slice(0, 10).map((o) => `${esc(o.name)} (${o.count})`).join(", ")}</div>` : "<div class=\"kmMuted\">Unknown</div>"}</div>
        </div>
        ${page.instances ? `<h3>Instances (${page.instances.registered} known)</h3><div class="kmGrid2"><table><thead><tr><th>Serial</th><th class="num">Count</th><th class="num">Share</th><th class="num">Premium</th></tr></thead><tbody>${brackets(page.instances.serial)}</tbody></table>${page.instances.wear.length ? `<table><thead><tr><th>Wear</th><th class="num">Count</th><th class="num">Share</th><th class="num">Premium</th></tr></thead><tbody>${brackets(page.instances.wear)}</tbody></table>` : ""}</div>` : ""}
        <h3>Cheapest listings${listings ? ` (${listings.total})` : ""}</h3>
        ${listingRows ? `<table><thead><tr><th class="num">Ask</th><th class="num">vs fair</th><th>Seller</th><th class="num">Listed</th><th></th></tr></thead><tbody>${listingRows}</tbody></table>` : "<div class=\"kmMuted\">None</div>"}
        <div style="display:none" id="kmHistoryData">${esc(JSON.stringify(history ?? null))}</div>`;
    }

    async analyze(){
        const { analyzer: a } = this;
        const side = (/** @type {"give"|"get"} */ which, /** @type {string} */ title) => `<div class="kmSide"><h4>${title}</h4>
            <div class="kmPick"><input class="kmPickInput" data-side="${which}" placeholder="Add an item by name"><div class="kmPickList" data-side="${which}" style="display:none"></div></div>
            <table><tbody>${a[which].map((i, idx) => `<tr><td>${esc(i.name)}</td><td class="num"><input type="number" min="1" max="10000" value="${i.count}" class="kmCount" data-side="${which}" data-index="${idx}" style="width:70px"></td><td><button class="kmRemove" data-side="${which}" data-index="${idx}">✕</button></td></tr>`).join("")}</tbody></table>
            <div class="kmRow" style="margin-top:8px"><label>KR</label><input type="number" min="0" class="kmKr" data-side="${which}" value="${which === "give" ? a.giveKr : a.getKr}" style="width:120px"></div></div>`;
        let verdictHtml = "<div class=\"kmEmpty\">Add what you give and what you get</div>";
        if (a.give.length || a.get.length || a.giveKr || a.getKr){
            const verdict = await marketApi.analyze({ give: a.give.map((i) => ({ skin: i.skin, count: i.count })), get: a.get.map((i) => ({ skin: i.skin, count: i.count })), giveKr: a.giveKr, getKr: a.getKr });
            if (!verdict) verdictHtml = await this.fail();
            else {
                this.foot(verdict.asOf);
                const text = { good: "Good for you", bad: "Bad for you", fair: "Fair trade", uncertain: "Too little data to judge" }[verdict.verdict];
                const lines = (/** @type {import("./types.js").TradeSide} */ sd) => sd.items.map((l) => `<tr><td>${esc(l.name)} × ${l.count}</td><td class="num">${l.unknown ? "<span class=\"kmMuted\">no value</span>" : formatKr(l.fair) + " kr"}</td><td>${l.unknown ? "" : grade(l.grade)}</td><td class="num">${formatKr(l.lineValue)}</td><td class="num kmMuted">${formatKr(l.liquidValue)}</td></tr>`).join("");
                verdictHtml = `<div class="kmVerdict ${verdict.verdict}">${text}</div>
                    <div class="kmMuted">You give ${formatKr(verdict.give.value)} kr, you get ${formatKr(verdict.get.value)} kr at fair value (${verdict.difference >= 0 ? "+" : ""}${formatKr(verdict.difference)} kr, ${formatPercent(verdict.differenceShare)}). Sold quickly: ${formatKr(verdict.give.liquidValue)} against ${formatKr(verdict.get.liquidValue)} kr.</div>
                    <ul class="kmMuted" style="margin:8px 0 12px 18px;padding:0">${verdict.drivers.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
                    <div class="kmGrid2"><table><thead><tr><th>You give</th><th class="num">Each</th><th>Liq.</th><th class="num">Value</th><th class="num">Quick</th></tr></thead><tbody>${lines(verdict.give)}</tbody></table><table><thead><tr><th>You get</th><th class="num">Each</th><th>Liq.</th><th class="num">Value</th><th class="num">Quick</th></tr></thead><tbody>${lines(verdict.get)}</tbody></table></div>`;
            }
        }
        return `<div class="kmGrid2">${side("give", "You give")}${side("get", "You get")}</div><div class="kmRow" style="margin-top:10px"><button class="kmBtn" id="kmAnalyzeGo">Analyze</button><button class="kmBtn" id="kmAnalyzeClear">Clear</button></div>${verdictHtml}`;
    }

    /**
     * wires the rendered tab: clicks on rows, the controls, the chart
     *
     * @param {string} tab
     */
    afterRender(tab){
        const { shadow } = this;
        if (!shadow) return;
        const body = getElement("#kmBody", shadow);
        for (const row of body.querySelectorAll("tr.kmClick")){
            row.addEventListener("click", () => this.show("item", Number(/** @type {HTMLElement} */ (row).dataset.skin)));
        }
        body.querySelector("#kmBack")?.addEventListener("click", () => this.show(this.previous ?? "search"));
        if (tab !== "item") this.previous = tab;

        if (tab === "search"){
            const read = () => ({
                q: /** @type {HTMLInputElement} */ (body.querySelector("#kmQ")).value.trim(),
                rarity: /** @type {HTMLSelectElement} */ (body.querySelector("#kmRarity")).value,
                type: /** @type {HTMLSelectElement} */ (body.querySelector("#kmType")).value,
                sort: /** @type {HTMLSelectElement} */ (body.querySelector("#kmSort")).value,
                page: 1,
            });
            const current = /** @type {{page: number}} */ (typeof this.arg === "object" && this.arg ? this.arg : { page: 1 });
            /** @type {number|undefined} */
            let debounce;
            body.querySelector("#kmQ")?.addEventListener("input", () => {
                clearTimeout(debounce);
                debounce = window.setTimeout(() => this.show("search", read()), 350);
            });
            for (const id of ["#kmRarity", "#kmType", "#kmSort"]) body.querySelector(id)?.addEventListener("change", () => this.show("search", read()));
            body.querySelector("#kmPrev")?.addEventListener("click", () => this.show("search", { ...read(), page: Math.max(1, (current.page ?? 1) - 1) }));
            body.querySelector("#kmNext")?.addEventListener("click", () => this.show("search", { ...read(), page: (current.page ?? 1) + 1 }));
            const q = body.querySelector("#kmQ");
            if (q instanceof HTMLInputElement && (this.arg === undefined || /** @type {any} */ (this.arg)?.q)){
                q.focus();
                q.setSelectionRange(q.value.length, q.value.length);
            }
        }
        for (const button of body.querySelectorAll(".kmWindow")) button.addEventListener("click", () => this.show("movers", /** @type {HTMLElement} */ (button).dataset.window));
        for (const button of body.querySelectorAll(".kmGradeBtn")) button.addEventListener("click", () => this.show("deals", /** @type {HTMLElement} */ (button).dataset.grade));
        for (const button of body.querySelectorAll(".kmRange")) button.addEventListener("click", () => this.show("item", { skin: Number(/** @type {any} */ (this.arg)?.skin ?? this.arg), range: /** @type {HTMLElement} */ (button).dataset.range }));
        body.querySelector("#kmNameGo")?.addEventListener("click", () => this.show("portfolio", /** @type {HTMLInputElement} */ (body.querySelector("#kmName")).value.trim()));
        body.querySelector("#kmName")?.addEventListener("keydown", (event) => {
            if (/** @type {KeyboardEvent} */ (event).key === "Enter") this.show("portfolio", /** @type {HTMLInputElement} */ (event.target).value.trim());
        });

        if (tab === "analyze") this.wireAnalyzer(body);
        this.drawCharts(tab, body);
    }

    /**
     * @param {HTMLElement} body
     */
    wireAnalyzer(body){
        const { analyzer: a } = this;
        for (const input of body.querySelectorAll(".kmPickInput")){
            const side = /** @type {"give"|"get"} */ (String(/** @type {HTMLElement} */ (input).dataset.side));
            const list = /** @type {HTMLElement} */ (body.querySelector(`.kmPickList[data-side="${side}"]`));
            /** @type {number|undefined} */
            let debounce;
            input.addEventListener("input", () => {
                clearTimeout(debounce);
                const q = /** @type {HTMLInputElement} */ (input).value.trim();
                if (q.length < 2){
                    list.style.display = "none";
                    return;
                }
                debounce = window.setTimeout(async() => {
                    /** @type {import("./types.js").SearchReply|null} */
                    const reply = await marketApi.cached(`/market/search?q=${encodeURIComponent(q)}&sort=volume&page=1`, MINUTE);
                    if (!reply || /** @type {HTMLInputElement} */ (input).value.trim() !== q) return;
                    list.innerHTML = reply.items.slice(0, 12).map((s) => `<div data-skin="${s.skin}" data-name="${esc(s.name)}">${thumb(s)}${esc(s.name)} <span class="kmMuted">${formatKr(s.fair)} kr</span></div>`).join("") || "<div class=\"kmMuted\">no match</div>";
                    list.style.display = "block";
                    for (const option of list.querySelectorAll("div[data-skin]")){
                        option.addEventListener("click", () => {
                            const el = /** @type {HTMLElement} */ (option);
                            const skin = Number(el.dataset.skin);
                            const existing = a[side].find((i) => i.skin === skin);
                            if (existing) existing.count++;
                            else a[side].push({ skin, count: 1, name: el.dataset.name ?? "" });
                            this.show("analyze");
                        });
                    }
                }, 300);
            });
        }
        for (const input of body.querySelectorAll(".kmCount")){
            input.addEventListener("change", () => {
                const el = /** @type {HTMLInputElement} */ (input);
                const entry = a[/** @type {"give"|"get"} */ (el.dataset.side)][Number(el.dataset.index)];
                if (entry) entry.count = Math.max(1, Math.min(10_000, Number(el.value) || 1));
            });
        }
        for (const input of body.querySelectorAll(".kmKr")){
            input.addEventListener("change", () => {
                const el = /** @type {HTMLInputElement} */ (input);
                const kr = Math.max(0, Number(el.value) || 0);
                if (el.dataset.side === "give") a.giveKr = kr;
                else a.getKr = kr;
            });
        }
        for (const button of body.querySelectorAll(".kmRemove")){
            button.addEventListener("click", () => {
                const el = /** @type {HTMLElement} */ (button);
                a[/** @type {"give"|"get"} */ (el.dataset.side)].splice(Number(el.dataset.index), 1);
                this.show("analyze");
            });
        }
        body.querySelector("#kmAnalyzeGo")?.addEventListener("click", () => this.show("analyze"));
        body.querySelector("#kmAnalyzeClear")?.addEventListener("click", () => {
            this.analyzer = { give: [], get: [], giveKr: 0, getKr: 0 };
            this.show("analyze");
        });
    }

    /**
     * @param {string} tab
     * @param {HTMLElement} body
     */
    async drawCharts(tab, body){
        const canvas = body.querySelector("#kmChart");
        if (!(canvas instanceof HTMLCanvasElement)) return;
        if (tab === "overview"){
            /** @type {import("./types.js").OverviewReply|null} */
            const o = await marketApi.cached("/market/overview", 60 * MINUTE);
            if (o && canvas.isConnected) drawChart(canvas, [{ values: o.days.map((d) => d.volume), color: "#f5479b", label: "kr volume" }], o.days.map((d) => d.day.slice(5)));
        }
        else if (tab === "indices"){
            /** @type {import("./types.js").IndicesReply|null} */
            const r = await marketApi.cached("/market/indices", 60 * MINUTE);
            const main = r?.indices.find((i) => i.name === "kute-100") ?? r?.indices[0];
            if (main && canvas.isConnected) drawChart(canvas, [{ values: main.series.map((p) => p.value), color: "#f5479b", label: main.name }], main.series.map((p) => p.day.slice(5)));
        }
        else if (tab === "portfolio"){
            const name = typeof this.arg === "string" && this.arg ? this.arg : localStorage.getItem("krunker_username") ?? "";
            /** @type {import("./types.js").PortfolioReply|null} */
            const p = name ? await marketApi.cached(`/market/portfolio?name=${encodeURIComponent(name)}`, 5 * MINUTE) : null;
            if (p && canvas.isConnected) drawChart(canvas, [{ values: p.series.map((d) => d.value), color: "#f5479b", label: "holdings value" }], p.series.map((d) => d.day.slice(5)));
        }
        else if (tab === "item"){
            const raw = body.querySelector("#kmHistoryData")?.textContent;
            /** @type {import("./types.js").HistoryReply|null} */
            const history = raw ? JSON.parse(raw) : null;
            if (!history) return;
            const labels = history.points.map((p) => {
                const d = new Date(p.t);
                return history.resolution === "hour" ? `${d.getHours()}:00` : `${d.getMonth() + 1}/${d.getDate()}`;
            });
            drawChart(canvas, [
                { values: history.points.map((p) => p.fair), color: "#f5479b", label: "Kute fair value" },
                { values: history.points.map((p) => p.avg), color: "#5ce05a", label: "avg sale" },
                { values: history.points.map((p) => p.lowest), color: "#2196F3", label: "lowest ask" },
                { values: history.points.map((p) => p.krunker), color: "#889", label: "Krunker est." },
            ], labels);
        }
    }
}

const terminal = new Terminal();
export default terminal;
