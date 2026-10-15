// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// response shapes as the api returns them, field names kept as documented

/** ranked region ids as the leaderboard endpoint takes them */
export const Region = {
    ASIA: 2,
    EUROPE: 3,
    NORTH_AMERICA: 4,
} as const;
export type RegionId = typeof Region[keyof typeof Region] | number;

export type LeaderboardType = "score" | "time";
/** 0 = ascending (lower is better), 1 = descending */
export type LeaderboardOrder = 0 | 1;
/** 1 = win, 0 = loss, -1 = draw */
export type MatchResult = 1 | 0 | -1;

export type Page = { page?: number };

export type PlayerRanked = {
    region: number;
    mmr: number;
    wins: number;
    losses: number;
    kills: number;
    deaths: number;
    assists: number;
    score: number;
    damage_done: number;
    time_played: number;
};

export type PlayerProfile = {
    player_id: number;
    player_name: string;
    /** empty when not in a clan */
    clan: string;
    verified: boolean;
    flag: number;
    badges: number[];
    following: number;
    followers: number;
    /** one entry per region with 6+ placement matches this season */
    ranked: PlayerRanked[];
    kr: number;
    level: number;
    junk: number;
    inventory: number;
    score: number;
    spk: number;
    kills: number;
    deaths: number;
    kdr: number;
    kpg: number;
    games: number;
    wins: number;
    losses: number;
    assists: number;
    melees: number;
    beatdowns: number;
    bullseyes: number;
    headshots: number;
    legshots: number;
    wallbangs: number;
    shots: number;
    hits: number;
    misses: number;
    time_played: number;
    nukes: number;
    airdrops: number;
    airdrops_stolen: number;
    slimes: number;
    juggernauts: number;
    juggernauts_killed: number;
    warmachines: number;
    /** undocumented: class id -> score with that class */
    class_stats: Record<string, number>;
    hacker_tagged: boolean;
    kpd: boolean;
    premium: boolean;
    /** undocumented, empty when not linked */
    twitch_name: string;
    /** empty when not premium */
    profile_picture: string;
    created_at: string;
    /** undocumented, only seen empty so far */
    maps: unknown[];
    /** undocumented, only seen empty so far */
    mods: unknown[];
};

export type InventoryItem = {
    skin_index: number;
    /** undocumented: id of the owned item, not the definition */
    skin_id: number;
    /** excludes market listings */
    count: number;
    /** undocumented */
    metadata: unknown | null;
    /** undocumented */
    stackable: boolean;
};

export type PlayerListing = {
    skin_index: number;
    price: number;
    listed_at: string;
};

export type PlayerListings = {
    page: number;
    per_page: number;
    listings: PlayerListing[];
};

export type PlayerMatch = {
    match_id: number;
    date: string;
    map: number;
    duration: number;
    season: number;
    region: number;
    kills: number;
    deaths: number;
    assists: number;
    score: number;
    damage_done: number;
    headshots: number;
    accuracy: number;
    objective_score: number;
    kr: number;
    victory: MatchResult;
    rounds_won: number;
    team: number;
    /** milliseconds */
    play_time: number;
    /** rating after this match */
    mmr: number;
};

export type PlayerMatches = {
    page: number;
    per_page: number;
    matches: PlayerMatch[];
};

export type PlayerPost = {
    date: string;
    text: string;
    votes: number;
    comment_count: number;
};

export type PlayerPosts = {
    page: number;
    per_page: number;
    posts: PlayerPost[];
};

export type MatchParticipant = {
    player_name: string;
    kills: number;
    deaths: number;
    assists: number;
    score: number;
    damage_done: number;
    headshots: number;
    accuracy: number;
    objective_score: number;
    victory: MatchResult;
    rounds_won: number;
    team: number;
    play_time: number;
};

export type MatchDetails = {
    match_id: number;
    date: string;
    map: number;
    duration: number;
    season: number;
    region: number;
    /** ordered by team, then score descending */
    participants: MatchParticipant[];
};

export type ClanProfile = {
    name: string;
    owner_name: string;
    score: number;
    rank: number;
    member_count: number;
    created_at: string;
    /** discord invite code, empty when not set */
    discord: string;
};

export type ClanMember = {
    player_name: string;
    role: number;
    verified: boolean;
    /** undocumented */
    score: number;
};

export type ClanMembers = {
    page: number;
    per_page: number;
    members: ClanMember[];
};

export type LeaderboardEntry = {
    position: number;
    player_name: string;
    mmr: number;
    wins: number;
    losses: number;
    kills: number;
    deaths: number;
    assists: number;
    score: number;
    damage_done: number;
};

export type RankedLeaderboard = {
    page: number;
    per_page: number;
    season: number;
    region: number;
    entries: LeaderboardEntry[];
};

export type MapInfo = {
    map_id: number;
    name: string;
    description: string;
    creator_name: string;
    votes: number;
    gameplays: number;
    /** milliseconds */
    playtime: number;
    category: number;
    /** "YYYY-MM-DD HH:MM:SS", not rfc3339 like the docs say */
    created_at: string;
    updated_at: string;
    /** "time", "score" or empty when the map has no leaderboard */
    leaderboard_type: LeaderboardType | "";
    leaderboard_order: LeaderboardOrder;
    /** undocumented */
    featured: boolean;
};

export type FeaturedMap = {
    map_id: number;
    name: string;
    creator_id: number;
    creator_name: string;
};

export type FeaturedMaps = {
    maps: FeaturedMap[];
    count: number;
};

export type MapLeaderboardEntry = {
    position: number;
    player_name: string;
    value: number;
    date: string;
};

export type MapLeaderboard = {
    page: number;
    per_page: number;
    map_name: string;
    leaderboard_type: LeaderboardType | "";
    leaderboard_order: LeaderboardOrder;
    entries: MapLeaderboardEntry[];
};

export type MapLeaderboardPlayer = {
    map_name: string;
    leaderboard_type: LeaderboardType;
    leaderboard_order: LeaderboardOrder;
    player_name: string;
    position: number;
    value: number;
    date: string;
};

export type Mod = {
    mod_id: number;
    name: string;
    description: string;
    creator_name: string;
    votes: number;
    featured: boolean;
    version: number;
    /** "YYYY-MM-DD HH:MM:SS", not rfc3339 like the docs say */
    created_at: string;
    updated_at: string;
};

export type Mods = {
    page: number;
    per_page: number;
    mods: Mod[];
};

export type MarketListing = {
    price: number;
    seller_name: string;
    listed_at: string;
};

export type MarketOwner = {
    player_name: string;
    count: number;
};

export type PricePoint = {
    /** YYYY-MM-DD */
    date: string;
    average_price: number;
    sales: number;
};

export type MarketSkin = {
    skin_index: number;
    total_listings: number;
    /** 0 without listings */
    lowest_price: number;
    /** sales of the last 7 days */
    average_price: number;
    total_circulating: number;
    /** page of active listings, cheapest first */
    listings: MarketListing[];
    /** up to 100, most owned first, banned users excluded */
    owners: MarketOwner[];
    /** only days with sales */
    price_history: PricePoint[];
};

/** extra config properties of a skin (creator, glow, frames, ...) get merged into the root, so the index signature is real */
export type SkinDefinition = {
    index: number;
    name: string;
    type: number;
    rarity: number;
    /** omitted when the skin has no weapon */
    weapon?: number;
    /** the season, named like in the game's config (the docs call it season) */
    seas?: number;
    /** undocumented, equals index on the single skin endpoint */
    id?: number;
    /** undocumented */
    thumbnail?: string;
    /** undocumented */
    tradable?: boolean;
} & Record<string, unknown>;

export type Skins = {
    page: number;
    per_page: number;
    total: number;
    skins: SkinDefinition[];
};

/** body of every error reply */
export type ApiErrorBody = {
    error: string | { code?: string; message?: string };
    retry_after?: number;
};
