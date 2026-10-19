const KEY = "kute_market_watch";
const MAX_ITEMS = 100;

/** @typedef {{skin:number,name:string,rarity?:number,thumbnail:string|null,target:number|null}} WatchItem */

/** @return {WatchItem[]} */
export function readWatchlist(){
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
        if (!Array.isArray(raw)) return [];
        const seen = new Set();
        return raw.filter((i) => {
            if (!i || !Number.isInteger(i.skin) || i.skin < 0 || seen.has(i.skin) || typeof i.name !== "string") return false;
            seen.add(i.skin);
            return true;
        }).slice(0, MAX_ITEMS).map((i) => ({ skin: i.skin, name: i.name, rarity: Number.isInteger(i.rarity) ? i.rarity : undefined, thumbnail: typeof i.thumbnail === "string" ? i.thumbnail : null, target: Number.isFinite(i.target) && i.target > 0 ? i.target : null }));
    }
    catch {
        return [];
    }
}

/** @param {WatchItem[]} items @return {boolean} */
export function saveWatchlist(items){
    try {
        localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
        window.dispatchEvent(new Event("kute-market-watch-changed"));
        return true;
    }
    catch {
        return false;
    }
}

/** @param {{skin:number,name:string,rarity?:number,thumbnail:string|null}} item @return {boolean} */
export function toggleWatch(item){
    const items = readWatchlist();
    const exists = items.some((i) => i.skin === item.skin);
    if (!exists && items.length >= MAX_ITEMS) return false;
    return saveWatchlist(exists ? items.filter((i) => i.skin !== item.skin) : [...items, { skin: item.skin, name: item.name, rarity: item.rarity, thumbnail: item.thumbnail ?? null, target: null }]);
}
