// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// shapes of the keyless endpoints (gapi.svc.krunker.io without a developer key, matchmaker.krunker.io,
// api.krunker.io), as the game's own clients read them. nothing here is documented by krunker: every
// field was taken from live replies on 2026-10-15 and from the game code map in the clan/turf api notes

/** the reply envelope of gapi.svc.krunker.io, a non-null error comes with a 4xx or 5xx */
export type Envelope<T> = {
    data: T;
    error: null | string | { code?: string; message?: string };
};

/** the packed stats blob of a social profile, the developer api's profile has the same numbers under full names */
export type PlayerStats = {
    /** shots */
    s: number;
    /** hits */
    h: number;
    /** headshots */
    hs: number;
    /** legshots */
    ls: number;
    /** wallbangs */
    wb: number;
    /** melee kills */
    mk: number;
    /** fist kills (beatdowns) */
    fk: number;
    /** thrown weapon kills (bullseyes) */
    tmk: number;
    /** assists */
    ast: number;
    /** nukes */
    n: number;
    /** airdrops */
    ad: number;
    /** airdrops stolen */
    sad: number;
    /** slimes */
    sl: number;
    /** warmachines */
    wm: number;
    /** country flag index */
    flg: number;
    /** 1 when the profile hides details */
    hds: number;
    /** score per class, c0 to c15 */
    c0?: number;
    c1?: number;
    c2?: number;
    c3?: number;
    c4?: number;
    c5?: number;
    c6?: number;
    c7?: number;
    c8?: number;
    c9?: number;
    c10?: number;
    c11?: number;
    c12?: number;
    c13?: number;
    c14?: number;
    c15?: number;
} & Record<string, number | string | undefined>;

export type MatchHistoryEntry = {
    player_name: string;
    accuracy: number;
    assists: number;
    damage_done: number;
    deaths: number;
    headshots: number;
    kills: number;
    objective_score: number;
    score: number;
    team: number;
    rank: number;
    mmr_change: number;
};

export type MatchHistoryGame = {
    date: string;
    map: number;
    duration: number;
    mode: number;
    season: number;
    region: number;
    is_competitive: number;
    is_ranked: number;
    match_history_processed: number;
    historyEntries: MatchHistoryEntry[];
    score_alpha: number;
    score_bravo: number;
};

export type RaidStats = {
    map_id: number;
    completions: number;
    attempts: number;
    best_time: number;
    ai_kills: number;
    boss_kills: number;
    deaths: number;
};

/** GET /players/:name, the legacy flat profile the social popup renders */
export type PlayerSocialProfile = {
    player_id: number;
    player_name: string;
    /** absent without a clan */
    player_clan?: string;
    clan_id?: number;
    player_twitchname: string;
    player_region: number;
    /** comma separated badge ids */
    player_badge: string;
    /** comma separated title ids */
    player_titles: string;
    /** "YYYY-MM-DD HH:MM:SS" */
    player_datenew: string;
    player_featured: number;
    /** kr */
    player_funds: number;
    player_skinvalue: number;
    player_elo: number;
    player_elo2: number;
    /** junk rating, a decimal as text */
    player_elo4: string;
    player_premium: number;
    player_kills: number;
    player_deaths: number;
    player_wins: number;
    player_games_played: number;
    player_score: number;
    /** seconds */
    player_timeplayed: number;
    player_following: number;
    player_followed: number;
    player_chal: number;
    player_infected: number;
    player_jobrating: number;
    player_jobratingpositive: number;
    player_calls: number;
    player_taggedaccounts: number;
    player_stats: PlayerStats;
    online: number;
    maps: unknown[];
    mods: unknown[];
    assets: unknown[];
    /** seen empty on every profile so far, the shape is from the game code */
    match_history: MatchHistoryGame[];
    ranked_rank: number;
    raid_stats: RaidStats[];
};

export type PlayerSearchResult = {
    player_id: number;
    player_name: string;
    player_score: number;
};

/** one day of market sales: funds earned, count sold, date */
export type PlayerSale = {
    f: number;
    t: number;
    /** YYYY-MM-DD */
    d: string;
};

export type PlayerFollow = {
    player_id: number;
    player_name: string;
    date: string;
    follow_state: number;
};

export type FeedPost = {
    /** post id */
    pid: number;
    /** poster name and id */
    pln: string;
    pli: number;
    tim: number;
    lnk: string;
    txt: string;
    ftr: number;
    typ: number;
    cln: string;
    flw: number;
    clr: number;
    prm: number;
    lnk2: string;
    /** votes */
    vot: number;
    dlk: number;
    /** comment count */
    cnt: number;
    exp: number;
    fds: number;
};

export type ClanPublicMember = {
    /** name */
    p: string;
    /** score */
    s: number;
    /** role: 0 recruit, 1 soldier, 2 captain, 3 commander; the creator is listed with 0 */
    r: number;
    /** hacker flag */
    h: number;
    pr: number;
    /** verified */
    ve: number;
    /** staff */
    su: number;
    /** score of the last 7 days */
    s7: number;
};

/** GET /clans/by-name/:name and /clans/:id/profile */
export type ClanPublicProfile = {
    clan_id: number;
    clan_name: string;
    clan_score: number;
    clan_funds: number;
    clan_rank: number;
    /** discord invite code */
    clan_link4: string;
    /** logo version, 0 or null without one; image at user-assets.krunker.io/clans/<clan_id>.png?v=<clan_logo> */
    clan_logo: number | null;
    /** "s<n>" = paint shader n, otherwise a color */
    clan_banner_color: string;
    creator_name: string;
    members: ClanPublicMember[];
};

export type LootDistributionMode = "clan_bank" | "even" | "top_weighted" | "performance" | "top_performance";

export type ClanLootConfig = {
    clan_id: number;
    distribution_mode: LootDistributionMode;
    clan_pct: number;
    top_player_count: number;
    top_player_pct: number;
    remainder_pct: number;
    min_games_required: number;
    updated_at: string;
    updated_by: number;
    updated_by_name: string;
};

export type ClanMotd = {
    message: string;
    set_by: number;
    set_by_name: string;
    set_at: string;
};

export type RecruitmentPost = {
    recruitment_id: number;
    clan_id: number;
    clan_name: string;
    clan_logo: number | null;
    description: string;
    looking_for: string;
    min_level: number;
    min_kd: number;
    region: string | null;
    language: string | null;
    is_active: number;
    created_at: string;
    updated_at: string;
    created_by: number;
    loot_mode: LootDistributionMode | null;
    loot_clan_pct: number | null;
    loot_top_player_count: number | null;
    loot_top_player_pct: number | null;
    loot_remainder_pct: number | null;
    loot_min_games: number | null;
};

export type RecruitmentBoard = {
    posts: RecruitmentPost[];
    total: number;
    page: number;
    limit: number;
};

export type TurfStatusEntry = {
    position: number;
    clan_id: number;
    clan_name: string;
    clan_logo: number | null;
    kills: number;
    deaths: number;
};

/** one turf map with its current owner */
export type TurfStatus = {
    map_id: number;
    map_name: string;
    clan_id: number;
    clan_name: string;
    clan_logo: number | null;
    kills: number;
    games: number;
    reward: number | null;
    /** top 5 */
    leaderboard: TurfStatusEntry[];
    total_kills_today: number;
    guaranteed_reward: number;
    estimated_reward: number;
};

export type TurfClanMap = {
    map_id: number;
    map_name: string;
    day: number;
    kills: number;
    deaths: number;
    games: number;
    position: number;
    comparison_kills: number;
    comparison_deaths: number;
    comparison_clan_name: string;
    comparison_clan_id: number;
    comparison_clan_logo: number | null;
    comparison_position: number;
};

export type TurfClan = {
    clan_id: number;
    clan_name: string;
    clan_logo: number | null;
    current_day: number;
    maps: TurfClanMap[];
    historical_days: Omit<TurfClanMap, "games">[];
};

export type TurfPlayerRow = {
    player_id: number;
    player_name: string;
    kills: number;
    deaths: number;
    games: number;
    kd: number;
};

export type TurfClanEarning = {
    day: number;
    map_id: number;
    map_name: string;
    reward: number;
};

export type TurfPayouts = {
    payouts: { player_id: number; player_name: string; total_kr: number }[];
    total: number;
};

export type TurfTopClan = {
    position: number;
    clan_id: number;
    clan_name: string;
    clan_logo: number | null;
    kills: number;
    deaths: number;
    games: number;
    kd: number;
};

export type TurfTopGrossingClan = {
    position: number;
    clan_id: number;
    clan_name: string;
    clan_logo: number | null;
    total_kr: number;
    distributed: number;
    bank: number;
};

export type TurfTopPlayer = {
    position: number;
    player_id: number;
    player_name: string;
    clan_id: number;
    clan_name: string;
    kills: number;
    deaths: number;
    games: number;
    kd: number;
    earnings: number;
};

export type TurfPlayer = {
    player_id: number;
    player_name: string;
    current_clan: string;
    current_clan_id: number;
    current_clan_logo: number | null;
    total_kills: number;
    total_deaths: number;
    total_games: number;
    kd: number;
    total_kr: number;
    first_day: number;
    last_day: number;
};

export type TurfContribution = {
    day: number;
    clan_id: number;
    clan_name: string;
    map_id: number;
    map_name: string;
    kills: number;
    deaths: number;
    games: number;
    kd: number;
};

export type TurfPlayerEarning = {
    day: number;
    map_id: number;
    map_name: string;
    clan_id: number;
    clan_name: string;
    amount: number;
};

export type PlayerLeaderboardType =
    | "player_score" | "player_kills" | "player_wins" | "player_timeplayed" | "player_funds" | "player_followed"
    | "player_nukes" | "player_skinvalue" | "player_eventcount" | "player_ranked_matches";

export type PlayerLeaderboardRow = {
    position: number;
    player_name: string;
    player_clan: string;
    player_featured: number;
    value: number;
};

export type ClanLeaderboardSort = "score" | "members";

export type ClanLeaderboardRow = {
    position: number;
    clan_name: string;
    clan_score: number;
    member_count: number;
    hack_count: number;
};

export type RaidSort = "time" | "completions";

/** GET /leaderboards/raids/:mapId, 100 rows; map 31 is a raid map, 0 is not ("invalid raid map ID") */
export type RaidLeaderboardRow = {
    position: number;
    player_name: string;
    player_clan: string;
    /** milliseconds */
    best_time: number;
    completions: number;
};

export type KrunkCupTeam = {
    id: number;
    total_kills: number;
    total_score: number;
    total_games: number;
};

/** rows of /leaderboards/krunkcup/players and .../teams/:id/contributors */
export type KrunkCupPlayerRow = {
    position: number;
    player_name: string;
    player_clan: string;
    kills: number;
    score: number;
    games: number;
};

/** GET /maps, index = id = preview image number at assets.krunker.io/img/maps/map_<id>.png */
export type OfficialMap = {
    name: string;
    id: number;
};

/** GET /maps/:id, the whole map file (120 KB for Burg), only the keys the client reads are named */
export type MapConfig = {
    name: string;
    modes?: unknown;
    spawns?: unknown[];
    objects?: unknown[];
    sky?: unknown;
    skyDome?: unknown;
} & Record<string, unknown>;

export type Title = {
    id: number;
    name: string;
    desc: string;
    rarity: number;
    requirements: { kind: "challenge" | "bundle" | "blackmarket" | string; text: string } | null;
    active: boolean;
};

/** the options object inside a game list entry */
export type GameOptions = {
    /** game version */
    v: string;
    /** gamemode id, see GAMEMODES in the matchmaker module */
    g: number;
    /** custom game */
    c: number;
    cm: number;
    /** map index */
    m: number;
    /** map name */
    i: string;
};

/** [game id, region key, players, max players, options, seconds left] */
export type GameListEntry = [string, string, number, number, GameOptions, number];

export type GameList = {
    games: GameListEntry[];
    totalPlayerCount: number;
};

/** region key (as in a game entry) -> lobby host:port to ping */
export type PingList = Record<string, string>;

export type LegacyMapRow = {
    map_id: number;
    map_name: string;
    map_votes: number;
    creatorname: string;
    map_featured: number;
    /** json text */
    map_info: string;
    map_updatecounter: number;
    map_pl: number;
    fund: number;
    category: string;
    partner: string;
    map_date: string;
};

export type LegacyMapList = {
    index: string;
    data: LegacyMapRow[];
};

export type Stream = {
    id: string;
    username: string;
    title: string;
    viewerCount: number;
    thumbnailUrl: string;
    startedAt: string;
    provider: string;
    featured: boolean;
    languageCode: string;
};

export type DropCampaign = {
    name: string;
    startDate: number;
    endDate: number;
    drops: { itemId: number }[];
    startDateISO: string;
    endDateISO: string;
};

export type TopStreams = {
    streams: Stream[];
    promo: boolean;
    dropCampaigns: DropCampaign[];
};

// found by recording the client's network on 2026-10-15 while the owner clicked through every menu; all anonymous

/** one row of GET /market/stats: skin index, in circulation, on sale, and the ask range while something is listed */
export type MarketStatRow = {
    ski: number;
    inC: number;
    onS: number;
    high?: number;
    low?: number;
};

export type MarketStats = {
    stats: MarketStatRow[];
    has_more: boolean;
    next_cursor: number | null;
};

/** sort of GET /market/stats; "rarity" is what the market tab sends, an unknown value is answered with the default order */
export type MarketStatsSort = "rarity" | string;

export type MarketStatsQuery = {
    cursor?: number;
    limit?: number;
    sort?: MarketStatsSort;
    rarities?: number[];
    weapons?: number[];
    types?: number[];
    season?: number;
    searchTerm?: string;
};

/** one day of sales of an item: kr, count, date; GET /items/:id/sales and /market/items/:id/sales-statistics */
export type ItemSale = PlayerSale;

export type ItemOwner = {
    /** name */
    nm: string;
    /** count owned */
    ct: number;
    /** staff */
    su: number;
    /** featured (verified) */
    ft: number;
    cr: number;
};

/** GET /items/:id/view, the item page of the social market */
export type ItemView = {
    stats: { onS: number; high: number; low: number; inC: number };
    owners: ItemOwner[];
    sales: unknown[];
    listings: unknown[];
    stackable: boolean;
    wearable: boolean;
};

export type FeedTab = "global" | string;

/** GET /social/post/:id */
export type SocialPost = {
    post: FeedPost;
    comments: unknown[];
};

export type SocialNews = {
    news: unknown[];
};

export type CreatorPoll = {
    id: number;
    title: string;
    description: string;
    /** seconds */
    ends_in: number;
};

/** GET /creators/events, the menu's event and survey box */
export type CreatorEvents = {
    events: unknown[];
    polls: CreatorPoll[];
};

/** GET /maps/by-name/:name, the community map record (the official Burg is a different thing, see OfficialMap) */
export type CommunityMap = {
    map_id: number;
    name: string;
    description: string;
    creator_name: string;
    votes: number;
    gameplays: number;
    playtime: number;
    category: number;
    created_at: string;
    updated_at: string;
    leaderboard_type: string;
    leaderboard_order: number;
    featured: boolean;
};

/** GET /maps/by-name/:name/leaderboard */
export type CommunityMapLeaderboard = {
    page: number;
    per_page: number;
    map_name: string;
    leaderboard_type: string;
    leaderboard_order: number;
    entries: unknown[];
};

/** GET /mods/by-name/:name */
export type ModInfo = {
    mod_id: number;
    name: string;
    description: string;
    creator_name: string;
    votes: number;
    featured: boolean;
    version: number;
    created_at: string;
    updated_at: string;
};

export type ShopPrice = {
    id: number;
    price_ref: string;
    type: string;
    real?: { price_usd: number };
    recurring?: { amount: number; periodicity: string };
    available: boolean;
};

export type ShopProduct = {
    id: number;
    name: string;
    description: string;
    image_url: string;
    active: boolean;
    prices: ShopPrice[];
    contents: { id: number; type: string; ref: string; quantity: number }[];
    available: boolean;
    display_ids: number[];
};

/** GET /shop/displays, a tree of displays with the products they show */
export type ShopDisplay = {
    id: number;
    type: string;
    order: number;
    data: Record<string, unknown>;
    children: { id: number; parent_id: number; order: number; type: string; data: Record<string, unknown>; product_id?: number }[];
    products: Record<string, ShopProduct>;
};

export type SpinPool = {
    id: string;
    name: string;
    color: string;
    weight: number;
    /** skin indices */
    items: number[];
};

/** GET /spins/wheels, the spin shop's wheels with their pools */
export type SpinWheel = {
    index: number;
    name: string;
    price: number;
    ticketIndex: number;
    ticketOnly: boolean;
    multi: number;
    poolWeights: number[];
    pools: SpinPool[];
} & Record<string, unknown>;

/** GET /lottery/:id (60 KB for id 1, every past draw with its prizes) */
export type Lottery = {
    lottery: { id: number; title: string; frequency: number; theme: string };
    player_entries: number;
    total_entries: number;
    previous_draws: ({ id: number; lottery_id: number; starts_at: string; ends_at: string; drawn_at: string; prizes: unknown[] } & Record<string, unknown>)[];
} & Record<string, unknown>;

/** GET api.krunker.io/webhooks/general/items/prices: index = skin index, null = no price (8069 entries) */
export type ItemPrices = (number | null)[];

export type LegacyModRow = {
    mod_id: number;
    mod_name: string;
    mod_votes: number;
    creatorname: string;
    mod_featured: number;
    mod_url: string;
    /** json text */
    mod_info: string;
    mod_updatecounter: number;
};

export type LegacyModList = {
    index: string;
    data: LegacyModRow[];
};
