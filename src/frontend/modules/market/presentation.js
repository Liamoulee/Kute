import { formatKr, formatPercent, GRADE_COLORS, RARITIES } from "./types.js";

export const TYPE_NAMES = ["Weapons", "Hats", "Bodies", "Melee", "Sprays", "Dyes", "Waists", "Faces", "Charms", "Emotes", "Stickers", "Skydomes", "Poses", "Spin tickets", "Capes", "Heads", "Paints", "Backs", "Consumables"];

export const TRADE_VERDICTS = {
    good: { label: "Favorable trade", detail: "More estimated value coming in" },
    fair: { label: "Fair trade", detail: "Similar estimated value" },
    bad: { label: "Unfavorable trade", detail: "More estimated value going out" },
    uncertain: { label: "Not enough evidence", detail: "Estimates are too uncertain for a verdict" },
};

/**
 * @param {string} verdict
 * @return {keyof typeof TRADE_VERDICTS} a verdict a newer server added reads as uncertain
 */
export const verdictOf = (verdict) => Object.hasOwn(TRADE_VERDICTS, verdict) ? /** @type {keyof typeof TRADE_VERDICTS} */ (verdict) : "uncertain";

/** @param {unknown} text */
export const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** @param {import("./types.js").TradeSide} side @param {string} label */
export const tradeBreakdown = (side, label) => `<div><h3>${label}</h3>${side.items.map((item) => `<div class="line"><span class="name">${item.count > 1 ? `${item.count} &times; ` : ""}${esc(item.name)}${item.serial !== undefined ? ` #${esc(item.serial)}` : ""}${item.wear !== undefined ? ` &middot; wear ${item.wear.toFixed(4)}` : ""}${item.unknown ? "" : `<span class="grade" title="Activity grade ${esc(item.grade)}" style="background:${GRADE_COLORS[item.grade]}">${esc(item.grade)}</span>`}</span><span class="amount">${item.unknown ? "Unvalued" : `${formatKr(item.lineValue)} KR`}</span></div>`).join("")}${side.kr ? `<div class="line"><span>Added KR</span><span>${formatKr(side.kr)} KR</span></div>` : ""}${!side.items.length && !side.kr ? '<span class="meta">No items added</span>' : ""}</div>`;

/** @param {import("./types.js").TradeVerdict} verdict @param {string[]} [extra] */
export const tradeNotes = (verdict, extra = []) => `<ul class="notes"><li>Estimates describe market data, not guaranteed sale prices. Activity grades do not guarantee a selling time.</li>${[...extra, ...verdict.drivers.filter((driver) => !driver.startsWith("Liquidity adjustments"))].map((driver) => `<li>${esc(driver)}</li>`).join("")}</ul>`;

/** @param {number|null|undefined} value */
export const money = (value) => value === null || value === undefined ? "Unavailable" : formatKr(value);

/** @param {number|null|undefined} value */
export const change = (value) => {
    if (value === null || value === undefined) return '<span class="muted">No trend yet</span>';
    let color = "muted";
    if (value > 0.005) color = "positive";
    if (value < -0.005) color = "negative";
    return `<span class="${color}">${esc(formatPercent(value))}</span>`;
};

/**
 * @param {{method?:string}} item
 * @return {boolean} the quick-sell floor or krunker's estimate, which say nothing about what it trades for
 */
export const noEvidence = (item) => item.method === "floor" || item.method === "krunker";

/** @param {{method?:string,onS?:number}} item */
export const singleListing = (item) => item.method === "ask" && item.onS === 1;

/**
 * @param {{fair?:number,method?:string,onS?:number}|null|undefined} item
 * @param {string} [unit] markup after the number
 * @return {string} the value, greyed out and labeled when it is no evidence
 */
export const fairValue = (item, unit = "") => {
    if (!item) return money(undefined);
    if (noEvidence(item)){
        const what = item.method === "floor" ? "Quick-sell floor" : "Krunker's estimate";
        return `<span class="noEvidence" title="${what}. There is no sale, trade or listing to price this item from.">${money(item.fair)}${unit}<small class="valueNote">${item.method === "floor" ? "floor" : "krunker"}</small></span>`;
    }
    if (singleListing(item)) return `${money(item.fair)}${unit}<small class="valueNote" title="Derived from one seller's asking price">1 listing</small>`;
    return `${money(item.fair)}${unit}`;
};

/** @param {import("./types.js").TradeLine} line */
export const lineNote = (line) => {
    if (!line.unknown) return `${money(line.fair)} KR each`;
    if (noEvidence(line)) return `No price evidence &middot; ${line.method === "floor" ? "floor" : "Krunker"} ${money(line.fair)}`;
    return "Needs more evidence";
};

/** @param {{method?:string, sales7d?:number, confidence?:number, onS?:number}} item */
export const evidenceLabel = (item) => {
    if (item.method === "floor") return "No price evidence, quick-sell floor";
    if (item.method === "krunker") return "No price evidence, Krunker's estimate";
    if (singleListing(item)) return "One listing only";
    if (item.method?.includes("trades")) return item.method.startsWith("sales") ? "Sales + private trades" : "Private-trade estimate";
    if (!item.method?.startsWith("sales")) return "Limited evidence";
    return (item.sales7d ?? 0) >= 5 ? "Recent sales" : "Sparse sales";
};

/** @param {{velocity?:number, sales7d?:number, privateTrading?:import("./types.js").PrivateTrading}} item */
export const activityLabel = (item) => {
    if (item.privateTrading?.trades7d) return `${item.privateTrading.trades7d} private trade${item.privateTrading.trades7d === 1 ? "" : "s"} this week${item.sales7d ? ` + ${item.sales7d} sales` : ""}`;
    if ((item.sales7d ?? 0) >= 7) return "Active this week";
    return (item.sales7d ?? 0) > 0 ? "Traded this week" : "No reported sales this week";
};

/** @param {{thumbnail?:string|null,name:string,rarity?:number}} item */
export const identity = (item) => `<span class="itemIdentity">${item.thumbnail ? `<img src="${esc(item.thumbnail)}" loading="lazy" alt="">` : "<span class=\"itemPlaceholder\">K</span>"}<span><b>${esc(item.name)}</b><small>${esc(RARITIES[item.rarity ?? -1]?.name ?? "Item")}</small></span></span>`;

/** @param {string} title @param {string} description @param {string} [action] */
export const empty = (title, description, action = "") => `<div class="empty"><span class="emptyMark">&#9671;</span><h2>${esc(title)}</h2><p>${esc(description)}</p>${action}</div>`;

/** @param {string} title @param {string} value @param {string} detail */
export const stat = (title, value, detail) => `<div class="metric"><span>${esc(title)}</span><strong>${value}</strong><small>${detail}</small></div>`;
