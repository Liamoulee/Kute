// the shapes the kute server answers with, mirrored from server/src/marketEngine.ts for checkJs

/**
 * @typedef {"A"|"B"|"C"|"D"|"F"} Grade
 *
 * @typedef {object} SkinValue
 * @property {number} skin
 * @property {number} fair
 * @property {number} confidence 0 to 100
 * @property {Grade} grade
 * @property {string} method sales7d, sales30d, sales90d, ask, krunker, floor
 * @property {number|null} lowest
 * @property {number|null} spread
 * @property {number|null} trend1d
 * @property {number|null} trend7d
 * @property {number|null} trend30d
 * @property {number} velocity
 * @property {number|null} krunker
 * @property {number} [valuedAt]
 * @property {number|null} [bookAt]
 *
 * @typedef {SkinValue & {name: string, rarity: number, type: number, season: number|null, thumbnail: string|null, onS: number, inC: number, sales7d: number, volume30d: number}} SkinSummary
 *
 * @typedef {object} SearchReply
 * @property {number} total
 * @property {number} page
 * @property {number} perPage
 * @property {SkinSummary[]} items
 * @property {number} asOf
 *
 * @typedef {{total: number, lowest: number|null, p25: number|null, median: number|null, p75: number|null, depthKr: number, sellers: number, maxByOne: number}} Depth
 * @typedef {{inC: number, topOwners: {name: string, count: number}[], top1Share: number|null, top10Share: number|null, top100Share: number|null}} Ownership
 * @typedef {{low: number|null, high: number|null, position: number|null}} PriceRange
 * @typedef {{label: string, count: number, share: number, premium: number|null, sales: number}} InstanceBracket
 *
 * @typedef {object} ItemAnalytics
 * @property {string} throughDay
 * @property {string|null} lastTradeDay
 * @property {number} observedDays30
 * @property {number} observedDays90
 * @property {number} consecutiveDays
 * @property {number} returnPairs30
 * @property {number|null} latest
 * @property {number|null} change7d
 * @property {number|null} change30d
 * @property {number|null} sma7
 * @property {number|null} sma30
 * @property {number|null} rsi14
 * @property {number|null} dailyVolatility30
 * @property {number|null} maxDrawdown90
 * @property {PriceRange} range90
 * @property {number|null} weightedPrice30
 * @property {number|null} estimateVsWeighted
 * @property {number} sales7d
 * @property {number} priorSales7d
 * @property {number} reportedDays7
 * @property {number} priorReportedDays7
 * @property {number|null} activityRatio
 * @property {number|null} turnover30d
 * @property {number} reportedListed
 * @property {number} circulation
 * @property {number|null} statsAt
 * @property {number|null} listedShare
 * @property {number|null} turnoverShare
 * @property {number|null} daysListedAtRecentPace
 * @property {{observedAt:number|null,sampled:number,knownSellerListings:number,sellers:number,largestSellerShare:number|null,belowEstimate:number,ladder:{premium:number,price:number,count:number,kr:number}[]}} book
 *
 * @typedef {object} ItemPage
 * @property {SkinSummary & {tradable: boolean, stackable: boolean|null, wearable: boolean|null, limType: string|null, noSpin: boolean, floor: number}} skin
 * @property {{grade: Grade, velocity: number, sales7d: number, sales30d: number, onSaleRatio: number|null, avgTimeToSellMs: number|null, spread: number|null}} liquidity
 * @property {Depth|null} depth
 * @property {Ownership|null} ownership
 * @property {PriceRange} range30
 * @property {PriceRange} range90
 * @property {number[]} weekdays
 * @property {{serial: InstanceBracket[], wear: InstanceBracket[], registered: number}|null} instances
 * @property {{days:number,sales:number,lastSaleDay:string|null,dailyRange:{low:number,high:number}|null,bookAt:number|null,updatedAt:number|null,reasons:string[]}} [evidence]
 * @property {ItemAnalytics} [analytics]
 * @property {import("./intelligence.js").ItemIntelligence} [intelligence]
 * @property {number} asOf
 *
 * @typedef {{t: number, lowest: number|null, median: number|null, sales: number, salesObserved?:boolean, volume: number, avg: number|null, fair: number|null, krunker: number|null, onS: number|null,ask?:{open:number,high:number,low:number,close:number,samples:number}|null}} HistoryPoint
 * @typedef {{skin: number, range: string, resolution: "hour"|"day", points: HistoryPoint[], asOf: number,salesSource?:string,askSource?:string}} HistoryReply
 * @typedef {{uid: number, price: number, listedAt: number|null, ageMs: number|null, seller: string|null, sellerListings: number, wear: number|null, serial: number|null}} ListingRow
 * @typedef {{skin: number, total: number, listings: ListingRow[], asOf: number,observedAt?:number|null,observedTotal?:number}} ListingsReply
 * @typedef {{window: string, gainers: (SkinSummary & {change: number})[], losers: (SkinSummary & {change: number})[], asOf: number}} MoversReply
 * @typedef {{uid: number, skin: number, name: string, rarity: number, thumbnail: string|null, price: number, fair: number, discount: number, grade: Grade, confidence: number, seller: string|null, ageMs: number|null,sales7d?:number,assessment?:{score:number,reasons:string[],risks:string[],historicalLow:number|null}}} Deal
 * @typedef {{deals: Deal[], asOf: number}} DealsReply
 * @typedef {{name: string, value: number, change1d: number|null, change7d: number|null, change30d: number|null, members: number, series: {day: string, value: number}[]}} IndexReply
 * @typedef {{indices: IndexReply[], asOf: number}} IndicesReply
 * @typedef {{days: {day: string, sales: number, volume: number}[], listingsLive: number, skinsListed: number, krOnBook: number, hours: number[], weekdays: number[], asOf: number,breadth?:{rising:number,falling:number,flat:number,eligible:number,total:number,window:string},categories?:{type:number,items:number,volume:number,change:number|null,rising?:number,falling?:number}[],diagnostics?:{medianChange:number|null,lowerQuartile:number|null,upperQuartile:number|null,advanceDeclineRatio:number|null,top10VolumeShare:number|null,eligibleVolume:number},active?:SkinSummary[],completedDay?:string|null,valuationAt?:number}} OverviewReply
 *
 * @typedef {{skin: number, count: number, serial?: number, wear?: number, style?: number}} TradeItem
 * @typedef {TradeItem & {name: string, fair: number, confidence: number, grade: Grade, unknown: boolean, lineValue: number, liquidValue: number, premium: number|null}} TradeLine
 * @typedef {{items: TradeLine[], kr: number, value: number, liquidValue: number, confidence: number}} TradeSide
 * @typedef {{give: TradeItem[], get: TradeItem[], giveKr: number, getKr: number}} TradeInput
 * @typedef {{verdict: "fair"|"good"|"bad"|"uncertain", difference: number, differenceShare: number, give: TradeSide, get: TradeSide, drivers: string[], asOf: number}} TradeVerdict
 *
 * @typedef {{skin: number, name: string, rarity: number, type: number, thumbnail: string|null, count: number, fair: number, value: number, grade: Grade, confidence: number, trend7d: number|null, trend30d: number|null}} PortfolioItem
 * @typedef {{name: string, totalValue: number, liquidValue: number, items: PortfolioItem[], byRarity: Record<string, number>, byType: Record<string, number>, best7d: PortfolioItem|null, worst7d: PortfolioItem|null, concentration: number, liquidShare: number, series: {day: string, value: number}[], asOf: number,unvaluedItems?:number,limitedEvidenceItems?:number,limitedEvidenceValue?:number,historyBasket?:{items:number,total:number,valueShare:number,series:{day:string,value:number}[]},historyCoverage?:{day:string,priced:number,total:number}[]}} PortfolioReply
 */

/** the game's rarity names and colors, from its rarity table */
export const RARITIES = [
    { name: "Uncommon", color: "#b2f252" },
    { name: "Rare", color: "#2196F3" },
    { name: "Epic", color: "#E040FB" },
    { name: "Legendary", color: "#FBC02D" },
    { name: "Relic", color: "#ff5722" },
    { name: "Contraband", color: "#f44336" },
    { name: "Unobtainable", color: "#ffffff" },
    { name: "NFT", color: "#9e9e9e" },
];

/** @type {Record<Grade, string>} */
export const GRADE_COLORS = { A: "#5ce05a", B: "#9ccc65", C: "#fbc02d", D: "#ff9800", F: "#f44336" };

/**
 * @param {number} kr
 * @return {string} 12,345 or 1.2M
 */
export function formatKr(kr){
    if (!Number.isFinite(kr)) return "?";
    if (Math.abs(kr) >= 1_000_000) return `${(kr / 1_000_000).toFixed(kr % 1_000_000 === 0 ? 0 : 1)}M`;
    return Math.round(kr).toLocaleString("en-US");
}

/**
 * @param {number|null|undefined} share -0.123
 * @return {string} -12.3 %
 */
export function formatPercent(share){
    if (share === null || share === undefined || !Number.isFinite(share)) return "–";
    const value = share * 100;
    return `${value > 0 ? "+" : ""}${Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)} %`;
}

/**
 * @param {number} ms
 * @return {string} 3 h, 2 d
 */
export function formatAge(ms){
    if (!Number.isFinite(ms) || ms < 0) return "–";
    const minutes = ms / 60_000;
    if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
    const hours = minutes / 60;
    if (hours < 48) return `${Math.round(hours)} h`;
    return `${Math.round(hours / 24)} d`;
}
