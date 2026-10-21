const LIMIT = 1_000_000_000;
const integer = (/** @type {unknown} */ n, min = 0, max = LIMIT) => typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
// history times come as "YYYY-MM-DD HH:MM:SS" in utc; Date.parse reads that in local time and two traders disagreed by their offset
const gameTime = (/** @type {unknown} */ value) => typeof value === "string" ? Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value) : NaN;

/** @param {unknown} value @return {Record<string,any>|null} */
function object(value){
    let parsed = value;
    if (typeof parsed === "string"){
        try { parsed = JSON.parse(parsed); }
        catch { return null; }
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

/** @param {unknown} value @return {import("./types.js").TradeItem & {paint?:number,instance?:number}|null} */
export function contributedItem(value){
    const row = typeof value === "number" ? { ind: value } : object(value);
    if (!row) return null;
    const skin = row.ind ?? row.skinindex ?? row.skin_index ?? row.i ?? row.index;
    const count = row.count ?? row.cnt ?? row.c ?? 1;
    if (!integer(skin) || !integer(count, 1) || count > 10_000) return null;
    const meta = object(row.m ?? row.metadata ?? row.meta) ?? {};
    /** @type {import("./types.js").TradeItem & {paint?:number,instance?:number}} */
    const result = { skin, count };
    for (const key of /** @type {const} */ (["serial", "wear", "style", "paint", "instance"])){
        const n = row[key] ?? meta[key];
        if (n === undefined || n === null) continue;
        if (key === "wear" ? typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1 : !integer(n)) return null;
        result[key] = n;
    }
    return result;
}

/** @param {unknown} value @return {{id:number,amount:number}[]|null} */
function currencies(value){
    if (typeof value === "number") return integer(value) ? [{ id: 1, amount: value }] : null;
    if (!Array.isArray(value) || value.length > 64) return null;
    const amounts = new Map();
    for (const raw of value){
        const row = object(raw);
        if (!row || !integer(row.cid, 1) || typeof row.amt !== "number" || !Number.isFinite(row.amt) || row.amt < 0 || row.amt > LIMIT || row.cid === 1 && !integer(row.amt)) return null;
        const amount = (amounts.get(row.cid) ?? 0) + row.amt;
        if (!Number.isFinite(amount) || amount > LIMIT) return null;
        amounts.set(row.cid, amount);
    }
    return [...amounts].filter(([, amount]) => amount > 0).map(([id, amount]) => ({ id, amount }));
}

/** @param {unknown} value @param {number} now */
export function contributedTrade(value, now){
    const row = object(value);
    if (!row || !integer(row.trid, 1, Number.MAX_SAFE_INTEGER) || (row.status && row.status !== "completed")) return null;
    const at = gameTime(row.dte ?? row.date);
    if (!Number.isFinite(at) || at < now - 48 * 3_600_000 || at > now) return null;
    if (!Array.isArray(row.sksell) || !Array.isArray(row.skbuy) || row.sksell.length + row.skbuy.length > 40) return null;
    const give = row.sksell.map(contributedItem); const get = row.skbuy.map(contributedItem);
    if ([...give, ...get].some(i => !i) || !give.length && !get.length) return null;
    const giveCurrencies = currencies(row.csell ?? []); const getCurrencies = currencies(row.cbuy ?? []);
    if (!giveCurrencies || !getCurrencies) return null;
    return {
        trid: row.trid, at, context: "history", give, get, giveCurrencies, getCurrencies,
        giveKr: giveCurrencies.find(c => c.id === 1)?.amount ?? 0,
        getKr: getCurrencies.find(c => c.id === 1)?.amount ?? 0,
    };
}

/** @param {unknown} value @param {number} now */
export function contributedSale(value, now){
    const row = object(value);
    if (!row || row.status !== "completed" || !integer(row.marketid, 1, Number.MAX_SAFE_INTEGER) || !integer(row.skinindex) || !integer(row.amount, 1)) return null;
    const at = gameTime(row.date);
    if (!Number.isFinite(at) || at < now - 48 * 3_600_000 || at > now || !["buy", "sell"].includes(row.type)) return null;
    return { marketid: row.marketid, type: row.type, skinindex: row.skinindex, amount: row.amount, date: new Date(at).toISOString() };
}
