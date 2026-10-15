// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// shapes of the endpoints that need a player's frvr token, taken from live replies with the owner's token on
// 2026-10-15 (one GET each) and the game's client code. "me" endpoints describe the token's player

/** GET /player/me, data is the packed account blob the game decodes itself */
export type MePlayer = {
    player: { id: string; name: string; data: unknown[] };
};

export type WalletCurrency = {
    id: number;
    name: string;
    symbol: string;
    amount: number;
};

/** GET /player/wallet, kr plus every studio currency */
export type Wallet = {
    currencies: WalletCurrency[];
    spending_tier: number;
};

/** GET /guest/profile, zeros without a guest token */
export type GuestProfile = {
    profile: { score: number; funds: number; kills: number; deaths: number; games: number; wins: number };
};

/** GET /account/usernames */
export type Usernames = {
    active: string;
    names: { name: string; state: string; leave_release_secs: number }[];
    cooldown_secs: number;
};

export type EmailPreferences = {
    chosen: boolean;
    promotional: boolean;
};

export type DiscordStatus = {
    configured: boolean;
    linked: boolean;
    id?: string;
    username?: string;
    globalName?: string;
    avatar?: string;
    linkedAt?: number;
    guildUrl?: string;
    inGuild?: boolean;
};

/** GET /ranked/shop, the skins bought with ranked currency */
export type RankedShop = {
    skins: { id: number; skin_id: number; price: number; max_purchase: number; purchase_count: number }[];
};

/** a reply that carries its refusal inside data (wild offer: "Wild offer is not available") */
export type SoftError = { error: string };

export type WildOffer = SoftError | Record<string, unknown>;

/** a custom skin of the token's player (the skin editor) */
export type CustomSkin = {
    skinId: number;
    name: string;
    type: number;
    weapon: number;
    rarity: number;
    itemConfig: Record<string, unknown>;
    playerId: number;
    createdAt: string;
    updatedAt: string;
};

export type CustomSkinsPage = {
    skins: CustomSkin[];
    total: number;
    page: number;
    pageSize: number;
};

export type CustomSkinsQuery = {
    page?: number;
    page_size?: number;
    type?: number;
    weapon?: number;
    search?: string;
};

/** GET /clans/my-applications, null without any */
export type MyApplications = {
    clan_ids: number[] | null;
};

export type MarketListing = {
    uid: number;
    marketid: number;
    /** the item instance */
    skinid: number;
    skinindex: number;
    /** asking price in kr */
    funds: number;
    seller_id: number;
    seller_name: string;
    /** unix ms */
    listed_time: number;
    /** how many of this skin the seller has listed */
    listing_count: number;
};

export type MarketListings = {
    listings: MarketListing[];
} & Record<string, unknown>;

export type MarketListingsSort = "latest" | "price_asc" | "price_desc" | "popular";

export type MarketListingsQuery = {
    item_id?: number;
    items?: number[];
    sort?: MarketListingsSort;
    cursor_id?: number;
    limit?: number;
    rarities?: number[];
    weapons?: number[];
    types?: number[];
    wears?: number[];
    season?: number;
    painted?: boolean;
    searchTerm?: string;
};

/** one inventory stack: skin index, count, instance id, state */
export type InventoryItem = {
    i: number;
    cnt: number;
    sid: number;
    st: number;
};

export type MarketHistorySort = "date_asc" | "date_desc" | "amount_asc" | "amount_desc" | "item_asc" | "item_desc";

export type MarketHistoryEntry = {
    marketid: number;
    type: "sell" | "buy" | string;
    date: string;
    skinindex: number;
    amount: number;
    other_party_id: number;
    other_party_name: string;
    status: string;
};

export type MarketHistory = {
    history: MarketHistoryEntry[];
} & Record<string, unknown>;

export type MarketHistoryQuery = {
    sort?: MarketHistorySort;
    cursor?: number;
    limit?: number;
};

/** GET /market/black-market, the skin indices on offer */
export type BlackMarket = number[];

export type BlackMarketRank = {
    peak_mmr: number | null;
};

export type TradeItem = { ind: number } & Record<string, unknown>;
export type TradeCurrency = { cid: number; amt: number };

export type Trade = {
    trid: number;
    sksell: TradeItem[];
    skbuy: TradeItem[];
    csell: TradeCurrency[];
    cbuy: TradeCurrency[];
    /** the other player's id */
    pl: number;
    /** the buyer's id */
    buy: number;
    buyer: string;
    player: string;
    message: string;
    /** "YYYY-MM-DD HH:MM:SS" */
    dte: string;
};

export type TradeHistory = {
    open: Trade[];
    completed: Trade[];
};

export type TradeHistoryQuery = {
    offset?: number;
    limit?: number;
    includeOpen?: boolean;
};

export type TradeInventories = {
    my_inventory: InventoryItem[];
    their_inventory: InventoryItem[];
};

export type TradePlayer = {
    player_id: number;
    player_name: string;
    player_score: number;
};

export type Wristband = {
    skin_index: number;
    claimed: boolean;
    style: number;
    instance_id: number;
};

export type KpdDemosQuery = {
    off?: number;
    q?: string;
};

export type RankedProfileEntry = {
    player_name: string;
    conservative_rating: number;
    total_matches: number;
    rank: number;
};

/** GET api.krunker.io/leaderboards/rankings/season/:season[/region/:region] */
export type RankedLeaderboard = {
    leaderboard: { position: number; profile: RankedProfileEntry }[];
    totalPages: number;
};

export type RankedLeaderboardQuery = {
    limit?: number;
    offset?: number;
    region?: number;
};

/** GET api.krunker.io/player-profile/me/season/:season[/region/:region], the only place with a season accuracy total */
export type RankedProfile = {
    profile: {
        player_id: number;
        season: number;
        rank: number;
        mu: number;
        sigma: number;
        conservative_rating: number;
        wins: number;
        losses: number;
        total_matches: number;
        total_kills: number;
        total_deaths: number;
        total_assists: number;
        total_score: number;
        total_objective_score: number;
        total_accuracy: number;
        total_damage_done: number;
        total_time_played: number;
        highest_kill_count: number;
        highest_damage_in_match: number;
        player_score: number;
        level: number;
        last_milestone_claimed: number;
        player_name: string;
    };
    milestones: { id: number; matches: number; reward: number }[];
};

export type RankedMatchHistory = {
    matchHistory: { matches: unknown[]; totalPages: number };
};

export type RankedMatchHistoryQuery = {
    limit?: number;
    offset?: number;
    gameMode?: number;
    /** undefined = all */
    isRanked?: boolean;
    region?: number;
};

export type RankedConnection = {
    serverUrl: string | null;
};

export type DailySpinProgress = {
    score: number;
    maxScore: number;
    stage: number;
    /** seconds */
    timeRemaining: number;
    claimed: boolean;
};
