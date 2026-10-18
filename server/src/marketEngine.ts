import { existsSync } from "node:fs";
import path from "node:path";
import Log from "./util/log";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// the market engine (collector, model, validation) is not part of this repository: src/market/ is a
// gitignored checkout of a private repository. the public server runs complete without it, the market
// routes then answer "unavailable". this file is the whole contract between the two: what the engine
// exports and the shapes the routes hand to clients

export type MarketJobStatus = {
    name: string;
    running: boolean;
    lastRun: number | null;
    lastOk: number | null;
    lastMs: number | null;
    runs: number;
    failures: number;
    resumable: boolean;
    note: string | null;
};

export type MarketStatus = {
    collector: boolean;
    jobs: MarketJobStatus[];
    counts: Record<string, number>;
};

export type Grade = "A" | "B" | "C" | "D" | "F";

/** what every card, row and trade line needs about a skin */
export type SkinValue = {
    skin: number;
    /** kr */
    fair: number;
    /** 0 to 100 */
    confidence: number;
    grade: Grade;
    /** how the value was made: sales7d, sales30d, sales90d, ask, krunker, floor */
    method: string;
    /** cheapest live ask, null without listings */
    lowest: number | null;
    /** (lowest - fair) / fair */
    spread: number | null;
    trend1d: number | null;
    trend7d: number | null;
    trend30d: number | null;
    /** sales a day over 7 days */
    velocity: number;
    /** krunker's own flat estimate */
    krunker: number | null;
};

export type SkinSummary = SkinValue & {
    name: string;
    rarity: number;
    type: number;
    season: number | null;
    thumbnail: string | null;
    onS: number;
    inC: number;
    sales7d: number;
    volume30d: number;
};

export type SearchSort = "volume" | "value" | "trend1d" | "trend7d" | "trend30d" | "liquidity" | "onsale" | "name";
export type SearchQuery = { q?: string; rarity?: number; type?: number; season?: number; sort?: SearchSort; page?: number };
export type SearchReply = { total: number; page: number; perPage: number; items: SkinSummary[]; asOf: number };

export type Depth = { total: number; lowest: number | null; p25: number | null; median: number | null; p75: number | null; depthKr: number; sellers: number; maxByOne: number };
export type OwnerInfo = { name: string; count: number };
export type Ownership = { inC: number; topOwners: OwnerInfo[]; top1Share: number | null; top10Share: number | null; top100Share: number | null };
export type PriceRange = { low: number | null; high: number | null; /** 0 at the low, 1 at the high */ position: number | null };
export type InstanceBracket = { label: string; count: number; share: number; premium: number | null; sales: number };

export type ItemPage = {
    skin: SkinSummary & { tradable: boolean; stackable: boolean | null; wearable: boolean | null; limType: string | null; noSpin: boolean; floor: number };
    liquidity: { grade: Grade; velocity: number; sales7d: number; sales30d: number; onSaleRatio: number | null; avgTimeToSellMs: number | null; spread: number | null; gradedAt: number };
    depth: Depth | null;
    ownership: Ownership | null;
    range30: PriceRange;
    range90: PriceRange;
    /** share of 90 day sales per weekday, sunday first */
    weekdays: number[];
    instances: { serial: InstanceBracket[]; wear: InstanceBracket[]; registered: number } | null;
    asOf: number;
};

export type HistoryRange = "1D" | "7D" | "1M" | "3M" | "1Y" | "ALL";
export type HistoryPoint = {
    /** start of the bucket, unix ms */
    t: number;
    lowest: number | null;
    median: number | null;
    sales: number;
    volume: number;
    avg: number | null;
    fair: number | null;
    krunker: number | null;
    onS: number | null;
};
export type HistoryReply = { skin: number; range: HistoryRange; resolution: "hour" | "day"; points: HistoryPoint[]; asOf: number };

export type ListingRow = { uid: number; price: number; listedAt: number | null; ageMs: number | null; seller: string | null; sellerListings: number; wear: number | null; serial: number | null };
export type ListingsReply = { skin: number; total: number; listings: ListingRow[]; asOf: number };

export type ValueReply = { values: Record<string, SkinValue>; asOf: number };

export type MoversWindow = "1D" | "7D" | "30D";
export type Mover = SkinSummary & { change: number };
export type MoversReply = { window: MoversWindow; gainers: Mover[]; losers: Mover[]; asOf: number };

export type Deal = { uid: number; skin: number; name: string; rarity: number; thumbnail: string | null; price: number; fair: number; discount: number; grade: Grade; confidence: number; seller: string | null; ageMs: number | null };
export type DealsQuery = { minGrade?: Grade; rarity?: number; type?: number; limit?: number };
export type DealsReply = { deals: Deal[]; asOf: number };

export type IndexReply = { name: string; value: number; change1d: number | null; change7d: number | null; change30d: number | null; members: number; series: { day: string; value: number }[] };
export type IndicesReply = { indices: IndexReply[]; asOf: number };

export type OverviewReply = {
    days: { day: string; sales: number; volume: number }[];
    listingsLive: number;
    skinsListed: number;
    krOnBook: number;
    /** share of inferred sales per utc hour */
    hours: number[];
    /** share of sales per weekday, sunday first */
    weekdays: number[];
    asOf: number;
};

export type TradeItem = { skin: number; count: number; serial?: number; wear?: number; style?: number };
export type TradeLine = TradeItem & { name: string; fair: number; confidence: number; grade: Grade; unknown: boolean; lineValue: number; liquidValue: number; premium: number | null };
export type TradeSide = { items: TradeLine[]; kr: number; value: number; liquidValue: number; confidence: number };
export type TradeInput = { give: TradeItem[]; get: TradeItem[]; giveKr: number; getKr: number };
export type TradeVerdict = {
    verdict: "fair" | "good" | "bad" | "uncertain";
    /** get minus give at fair value, kr */
    difference: number;
    /** difference relative to the larger side */
    differenceShare: number;
    give: TradeSide;
    get: TradeSide;
    /** the items that make the difference, as sentences */
    drivers: string[];
    asOf: number;
};

export type PortfolioItem = { skin: number; name: string; rarity: number; type: number; thumbnail: string | null; count: number; fair: number; value: number; grade: Grade; confidence: number; trend7d: number | null; trend30d: number | null };
export type PortfolioReply = {
    name: string;
    totalValue: number;
    liquidValue: number;
    items: PortfolioItem[];
    byRarity: Record<string, number>;
    byType: Record<string, number>;
    best7d: PortfolioItem | null;
    worst7d: PortfolioItem | null;
    /** share of the value in the two biggest positions */
    concentration: number;
    /** share of the value in grade A to C items */
    liquidShare: number;
    /** value of the current holdings over the last 90 days */
    series: { day: string; value: number }[];
    asOf: number;
};

export type ObservedListing = { uid: number; marketid: number; skinindex: number; skinid: number; funds: number; seller_id: number; seller_name: string; listed_time: number; m?: string };
export type ObservedSale = { marketid: number; type: "sell" | "buy"; skinindex: number; amount: number; date: string };
export type ObservedTradeItem = { skin: number; count: number; serial?: number; wear?: number; style?: number };
export type ObservedTrade = { trid?: number; at: number; context: "history" | "plaza" | "window"; give: ObservedTradeItem[]; get: ObservedTradeItem[]; giveKr: number; getKr: number };
export type ObserveBody = { listings?: ObservedListing[]; sales?: ObservedSale[]; trades?: ObservedTrade[] };
export type ObserveResult = { accepted: number; rejected: number };

export type MarketQuery = {
    search(query: SearchQuery): SearchReply;
    item(skin: number): Promise<ItemPage | null>;
    history(skin: number, range: HistoryRange): HistoryReply | null;
    listings(skin: number): ListingsReply | null;
    value(skins: number[]): ValueReply;
    /** the same by the preview image path the game draws a card with (unique per skin), keyed by that path */
    valueByThumbnails(paths: string[]): ValueReply;
    movers(window: MoversWindow): MoversReply;
    deals(query: DealsQuery): DealsReply;
    indices(): IndicesReply;
    overview(): OverviewReply;
    analyze(trade: TradeInput): TradeVerdict;
    portfolio(name: string): Promise<PortfolioReply | null>;
    /** `session` is an opaque key for the contribution trust, never a player */
    observe(session: string, body: ObserveBody): ObserveResult;
};

export type MarketEngine = {
    /** opens the market database and, where enabled, schedules the collector */
    start(): void;
    status(): MarketStatus;
    query: MarketQuery;
};

/** the engine when its checkout is present, else null; the path is a variable so the compiler does not look for it */
export async function loadMarketEngine(): Promise<MarketEngine | null> {
    const entry = path.join(import.meta.dir, "market", "index.ts");
    if (!existsSync(entry)){
        Log.info("Market engine is not checked out (src/market), the market routes answer unavailable.");
        return null;
    }
    const specifier = "./market/index.ts";
    try {
        const engine = await import(specifier) as MarketEngine;
        if (typeof engine.start !== "function" || typeof engine.status !== "function" || typeof engine.query !== "object") throw new Error("the module does not export start, status and query");
        return engine;
    }
    catch (err){
        Log.error("Market engine failed to load: " + (err as Error).message, err as Error);
        return null;
    }
}
