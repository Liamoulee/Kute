import { krunker } from "./index";
import { apiCache, POLICIES, type Route } from "./cache/index";
import type {
    BrowserQuery,
    ClanLeaderboardSort,
    CommunityLeaderboardQuery,
    DayMapQuery,
    FeedTab,
    MapLeaderboardQuery,
    MarketSkinQuery,
    MarketStatsQuery,
    MatchesQuery,
    Page,
    PlayerLeaderboardQuery,
    PlayerLeaderboardType,
    RaidSort,
    RankedQuery,
    RecruitmentQuery,
    RegionId,
    SkinsQuery,
} from "krapio";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// same shape as krunker, every call goes through the cache with its route's policy.
// routes use this, never krunker directly: one careless endpoint burns the key's window for every player.
//   cached.player.profile("name")   cache first, krunker only when the policy says so
//   refresh.player.profile("name")  always krunker, the reply replaces the cached entry
//   cached.game.players.get("name")  the keyless endpoints, same two modes
// krunker.as(token) is not in here: a token names a player, so what a kute endpoint may cache
// and under which key (the jwt's sub, never the token) is decided there, per endpoint

/** names are matched case-insensitively by the api, so one entry serves every spelling */
const lower = (name: string): string => name.trim().toLowerCase();
const page = (query: Page): number => query.page ?? 1;

type Def<A extends unknown[], R> = { route: Route; keyOf: (...args: A) => unknown[]; fn: (...args: A) => Promise<R> };
type Defs = { [name: string]: Def<never[], unknown> | Defs };
type Facade<D> = { [K in keyof D]: D[K] extends Def<infer A, infer R> ? (...args: A) => Promise<R> : Facade<D[K]> };

const def = <A extends unknown[], R>(route: Route, keyOf: (...args: A) => unknown[], fn: (...args: A) => Promise<R>): Def<A, R> => ({ route, keyOf, fn });

const defs = {
    player: {
        profile: def("player.profile", (name: string) => [lower(name)], (name) => krunker.player.profile(name)),
        inventory: def("player.inventory", (name: string) => [lower(name)], (name) => krunker.player.inventory(name)),
        listings: def("player.listings", (name: string, q: Page = {}) => [lower(name), page(q)], (name, q) => krunker.player.listings(name, q)),
        matches: def("player.matches", (name: string, q: MatchesQuery = {}) => [lower(name), page(q), q.season ?? 0], (name, q) => krunker.player.matches(name, q)),
        posts: def("player.posts", (name: string, q: Page = {}) => [lower(name), page(q)], (name, q) => krunker.player.posts(name, q)),
    },
    match: {
        get: def("match.get", (id: number | string | bigint) => [String(id)], (id) => krunker.match.get(id)),
    },
    clan: {
        profile: def("clan.profile", (name: string) => [lower(name)], (name) => krunker.clan.profile(name)),
        members: def("clan.members", (name: string, q: Page = {}) => [lower(name), page(q)], (name, q) => krunker.clan.members(name, q)),
    },
    leaderboard: {
        ranked: def("leaderboard.ranked", (region: RegionId, q: RankedQuery = {}) => [region, page(q), q.season ?? 0], (region, q) => krunker.leaderboard.ranked(region, q)),
    },
    map: {
        get: def("map.get", (name: string) => [lower(name)], (name) => krunker.map.get(name)),
        featured: def("map.featured", () => [], () => krunker.map.featured()),
        leaderboard: def("map.leaderboard", (name: string, q: Page & MapLeaderboardQuery = {}) => [lower(name), page(q), q.type ?? "", q.order ?? -1], (name, q) => krunker.map.leaderboard(name, q)),
        leaderboardPlayer: def("map.leaderboardPlayer", (name: string, player: string, q: MapLeaderboardQuery = {}) => [lower(name), lower(player), q.type ?? "", q.order ?? -1], (name, player, q) => krunker.map.leaderboardPlayer(name, player, q)),
    },
    mods: {
        list: def("mods.list", (q: Page = {}) => [page(q)], (q) => krunker.mods.list(q)),
        // mod name case handling is unverified, the key keeps the spelling
        get: def("mods.get", (name: string) => [name.trim()], (name) => krunker.mods.get(name)),
    },
    market: {
        skin: def("market.skin", (index: number, q: MarketSkinQuery = {}) => [index, page(q), q.days ?? 30], (index, q) => krunker.market.skin(index, q)),
    },
    skins: {
        list: def("skins.list", (q: SkinsQuery = {}) => [page(q), q.per_page ?? 100, q.season ?? 0], (q) => krunker.skins.list(q)),
        get: def("skins.get", (index: number) => [index], (index) => krunker.skins.get(index)),
    },
    game: {
        players: {
            get: def("game.players.get", (name: string) => [lower(name)], (name) => krunker.game.players.get(name)),
            search: def("game.players.search", (q: string, limit = 5) => [lower(q), limit], (q, limit) => krunker.game.players.search(q, limit)),
            sales: def("game.players.sales", (name: string, range = 3) => [lower(name), range], (name, range) => krunker.game.players.sales(name, range)),
            listings: def("game.players.listings", (name: string) => [lower(name)], (name) => krunker.game.players.listings(name)),
            followers: def("game.players.followers", (name: string) => [lower(name)], (name) => krunker.game.players.followers(name)),
            following: def("game.players.following", (name: string) => [lower(name)], (name) => krunker.game.players.following(name)),
            feed: def("game.players.feed", (id: number, limit = 20) => [id, limit], (id, limit) => krunker.game.players.feed(id, limit)),
        },
        clans: {
            byName: def("game.clans.byName", (name: string) => [lower(name)], (name) => krunker.game.clans.byName(name)),
            profile: def("game.clans.profile", (id: number) => [id], (id) => krunker.game.clans.profile(id)),
            lootConfig: def("game.clans.lootConfig", (id: number) => [id], (id) => krunker.game.clans.lootConfig(id)),
            motd: def("game.clans.motd", (id: number) => [id], (id) => krunker.game.clans.motd(id)),
            recruitment: def("game.clans.recruitment", (id: number) => [id], (id) => krunker.game.clans.recruitment(id)),
            recruitmentBoard: def("game.clans.recruitmentBoard", (q: RecruitmentQuery = {}) => [page(q), q.limit ?? 20, q.region ?? "", q.language ?? ""], (q) => krunker.game.clans.recruitmentBoard(q)),
        },
        turf: {
            status: def("game.turf.status", () => [], () => krunker.game.turf.status()),
            clan: def("game.turf.clan", (id: number) => [id], (id) => krunker.game.turf.clan(id)),
            clanPlayers: def("game.turf.clanPlayers", (id: number, q: DayMapQuery = {}) => [id, q.day ?? -1, q.map_id ?? -1], (id, q) => krunker.game.turf.clanPlayers(id, q)),
            clanEarnings: def("game.turf.clanEarnings", (id: number) => [id], (id) => krunker.game.turf.clanEarnings(id)),
            clanPayouts: def("game.turf.clanPayouts", (id: number, day?: number) => [id, day ?? -1], (id, day) => krunker.game.turf.clanPayouts(id, day)),
            topClans: def("game.turf.topClans", (q: DayMapQuery & { clan_name?: string } = {}) => [q.day ?? -1, q.map_id ?? -1, lower(q.clan_name ?? "")], (q) => krunker.game.turf.topClans(q)),
            topGrossing: def("game.turf.topGrossing", (clanName?: string) => [lower(clanName ?? "")], (clanName) => krunker.game.turf.topGrossing(clanName)),
            topPlayers: def("game.turf.topPlayers", (q: { map_id?: number; player_name?: string } = {}) => [q.map_id ?? -1, lower(q.player_name ?? "")], (q) => krunker.game.turf.topPlayers(q)),
            player: def("game.turf.player", (id: number) => [id], (id) => krunker.game.turf.player(id)),
            playerContributions: def("game.turf.playerContributions", (id: number, day?: number) => [id, day ?? -1], (id, day) => krunker.game.turf.playerContributions(id, day)),
            playerEarnings: def("game.turf.playerEarnings", (id: number) => [id], (id) => krunker.game.turf.playerEarnings(id)),
        },
        leaderboards: {
            players: def("game.leaderboards.players", (type: PlayerLeaderboardType, q: PlayerLeaderboardQuery = {}) => [type, q.sort ?? "", q.season ?? 0], (type, q) => krunker.game.leaderboards.players(type, q)),
            clans: def("game.leaderboards.clans", (sort: ClanLeaderboardSort = "score") => [sort], (sort) => krunker.game.leaderboards.clans(sort)),
            raids: def("game.leaderboards.raids", (mapId: number, sort?: RaidSort) => [mapId, sort ?? ""], (mapId, sort) => krunker.game.leaderboards.raids(mapId, sort)),
            raidsMonthly: def("game.leaderboards.raidsMonthly", (mapId: number, month: string, sort?: RaidSort) => [mapId, month, sort ?? ""], (mapId, month, sort) => krunker.game.leaderboards.raidsMonthly(mapId, month, sort)),
            krunkCupTeams: def("game.leaderboards.krunkCupTeams", () => [], () => krunker.game.leaderboards.krunkCupTeams()),
            krunkCupContributors: def("game.leaderboards.krunkCupContributors", (teamId: number) => [teamId], (teamId) => krunker.game.leaderboards.krunkCupContributors(teamId)),
            krunkCupPlayers: def("game.leaderboards.krunkCupPlayers", (limit?: number) => [limit ?? 0], (limit) => krunker.game.leaderboards.krunkCupPlayers(limit)),
        },
        game: {
            maps: def("game.game.maps", () => [], () => krunker.game.game.maps()),
            mapConfig: def("game.game.mapConfig", (mapId: number) => [mapId], (mapId) => krunker.game.game.mapConfig(mapId)),
            mapByName: def("game.game.mapByName", (name: string) => [lower(name)], (name) => krunker.game.game.mapByName(name)),
            mapLeaderboard: def("game.game.mapLeaderboard", (name: string, q: CommunityLeaderboardQuery = {}) => [lower(name), page(q), q.type ?? "", q.order ?? -1], (name, q) => krunker.game.game.mapLeaderboard(name, q)),
            modByName: def("game.game.modByName", (name: string) => [name.trim()], (name) => krunker.game.game.modByName(name)),
            titles: def("game.game.titles", () => [], () => krunker.game.game.titles()),
            creatorEvents: def("game.game.creatorEvents", () => [], () => krunker.game.game.creatorEvents()),
        },
        shop: {
            display: def("game.shop.display", (id: number) => [id], (id) => krunker.game.shop.display(id)),
            displayByTag: def("game.shop.displayByTag", (tag: string) => [lower(tag)], (tag) => krunker.game.shop.displayByTag(tag)),
            spinWheels: def("game.shop.spinWheels", () => [], () => krunker.game.shop.spinWheels()),
            lottery: def("game.shop.lottery", (id: number) => [id], (id) => krunker.game.shop.lottery(id)),
        },
        market: {
            stats: def("game.market.stats", (q: MarketStatsQuery = {}) => [q.cursor ?? 0, q.limit ?? 0, q.sort ?? "", q.rarities ?? [], q.weapons ?? [], q.types ?? [], q.season ?? 0, lower(q.searchTerm ?? "")], (q) => krunker.game.market.stats(q)),
            itemSales: def("game.market.itemSales", (skinIndex: number) => [skinIndex], (skinIndex) => krunker.game.market.itemSales(skinIndex)),
            itemSalesStatistics: def("game.market.itemSalesStatistics", (skinIndex: number, daysBack = 30) => [skinIndex, daysBack], (skinIndex, daysBack) => krunker.game.market.itemSalesStatistics(skinIndex, daysBack)),
        },
        items: {
            view: def("game.items.view", (skinIndex: number) => [skinIndex], (skinIndex) => krunker.game.items.view(skinIndex)),
            sales: def("game.items.sales", (skinIndex: number, range = 6) => [skinIndex, range], (skinIndex, range) => krunker.game.items.sales(skinIndex, range)),
            instances: def("game.items.instances", (skinIndex: number, sort = "mint") => [skinIndex, sort], (skinIndex, sort) => krunker.game.items.instances(skinIndex, sort)),
        },
        social: {
            feed: def("game.social.feed", (tab: FeedTab = "global", limit?: number) => [tab, limit ?? 0], (tab, limit) => krunker.game.social.feed(tab, limit)),
            post: def("game.social.post", (postId: number) => [postId], (postId) => krunker.game.social.post(postId)),
            news: def("game.social.news", () => [], () => krunker.game.social.news()),
        },
        matchmaker: {
            gameList: def("game.matchmaker.gameList", () => [], () => krunker.game.matchmaker.gameList()),
            pingList: def("game.matchmaker.pingList", () => [], () => krunker.game.matchmaker.pingList()),
            gameInfo: def("game.matchmaker.gameInfo", (gameId: string) => [gameId], (gameId) => krunker.game.matchmaker.gameInfo(gameId)),
        },
        legacy: {
            mapsList: def("game.legacy.mapsList", (q: BrowserQuery = {}) => [q.index ?? 0, q.pos ?? 0], (q) => krunker.game.legacy.mapsList(q)),
            modsList: def("game.legacy.modsList", (q: BrowserQuery = {}) => [q.index ?? 0, q.pos ?? 0], (q) => krunker.game.legacy.modsList(q)),
            itemPrices: def("game.legacy.itemPrices", () => [], () => krunker.game.legacy.itemPrices()),
            topStreams: def("game.legacy.topStreams", () => [], () => krunker.game.legacy.topStreams()),
        },
    },
} satisfies Defs;

const isDef = (value: Def<never[], unknown> | Defs): value is Def<never[], unknown> => "route" in value;

function build<D extends Defs>(tree: D, mode: "cached" | "refresh"): Facade<D> {
    const out: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(tree)){
        if (!isDef(node)){
            out[name] = build(node, mode);
            continue;
        }
        const { route, keyOf, fn } = node as Def<unknown[], unknown>;
        out[name] = (...args: unknown[]): Promise<unknown> => {
            const key = `${route}:${JSON.stringify(keyOf(...args))}`;
            const fetcher = (): Promise<unknown> => fn(...args);
            return mode === "cached" ? apiCache.through(key, POLICIES[route], fetcher) : apiCache.refresh(key, POLICIES[route], fetcher);
        };
    }
    return out as Facade<D>;
}

export const cached = build(defs, "cached");
export const refresh = build(defs, "refresh");

export { apiCache };
