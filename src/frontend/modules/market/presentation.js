import { formatKr, formatPercent, RARITIES } from "./types.js";

export const TYPE_NAMES = ["Weapons", "Hats", "Bodies", "Melee", "Sprays", "Dyes", "Waists", "Faces", "Charms", "Emotes", "Stickers", "Skydomes", "Poses", "Spin tickets", "Capes", "Heads", "Paints", "Backs", "Consumables"];

export const TRADE_VERDICTS = {
    good: { label: "Favorable trade", detail: "More estimated value coming in" },
    fair: { label: "Fair trade", detail: "Similar estimated value" },
    bad: { label: "Unfavorable trade", detail: "More estimated value going out" },
    uncertain: { label: "Not enough evidence", detail: "Estimates are too uncertain for a verdict" },
};

/** @param {unknown} text */
export const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

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

/** @param {{method?:string, sales7d?:number, confidence?:number}} item */
export const evidenceLabel = (item) => {
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
