import { krunker } from "./index";
import { krunkerPublic } from "./public/index";
import { apiCache, POLICIES, type Route } from "./cache/index";
import type { MatchesQuery } from "./resources/player";
import type { RankedQuery } from "./resources/leaderboard";
import type { MapLeaderboardQuery } from "./resources/map";
import type { MarketSkinQuery } from "./resources/market";
import type { SkinsQuery } from "./resources/skins";
import type { Page, RegionId } from "./types";
import type { RecruitmentQuery } from "./public/resources/clans";
import type { DayMapQuery } from "./public/resources/turf";
import type { PlayerLeaderboardQuery } from "./public/resources/leaderboards";
import type { CommunityLeaderboardQuery } from "./public/resources/game";
import type { BrowserQuery } from "./public/resources/legacy";
import type { ClanLeaderboardSort, FeedTab, MarketStatsQuery, PlayerLeaderboardType, RaidSort } from "./public/types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// same shape as krunker, every call goes through the cache with its route's policy.
// routes use this, never krunker directly: one careless endpoint burns the key's window for every player.
//   cached.player.profile("name")   cache first, krunker only when the policy says so
//   refresh.player.profile("name")  always krunker, the reply replaces the cached entry
//   cached.public.players.get("name")  the keyless endpoints, same two modes
// the token wrapper (./token) is not in here: a token names a player, so what a kute endpoint may cache
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
    "public": {
        players: {
            get: def("public.players.get", (name: string) => [lower(name)], (name) => krunkerPublic.players.get(name)),
            search: def("public.players.search", (q: string, limit = 5) => [lower(q), limit], (q, limit) => krunkerPublic.players.search(q, limit)),
            sales: def("public.players.sales", (name: string, range = 3) => [lower(name), range], (name, range) => krunkerPublic.players.sales(name, range)),
            listings: def("public.players.listings", (name: string) => [lower(name)], (name) => krunkerPublic.players.listings(name)),
            followers: def("public.players.followers", (name: string) => [lower(name)], (name) => krunkerPublic.players.followers(name)),
            following: def("public.players.following", (name: string) => [lower(name)], (name) => krunkerPublic.players.following(name)),
            feed: def("public.players.feed", (id: number, limit = 20) => [id, limit], (id, limit) => krunkerPublic.players.feed(id, limit)),
        },
        clans: {
            byName: def("public.clans.byName", (name: string) => [lower(name)], (name) => krunkerPublic.clans.byName(name)),
            profile: def("public.clans.profile", (id: number) => [id], (id) => krunkerPublic.clans.profile(id)),
            lootConfig: def("public.clans.lootConfig", (id: number) => [id], (id) => krunkerPublic.clans.lootConfig(id)),
            motd: def("public.clans.motd", (id: number) => [id], (id) => krunkerPublic.clans.motd(id)),
            recruitment: def("public.clans.recruitment", (id: number) => [id], (id) => krunkerPublic.clans.recruitment(id)),
            recruitmentBoard: def("public.clans.recruitmentBoard", (q: RecruitmentQuery = {}) => [page(q), q.limit ?? 20, q.region ?? "", q.language ?? ""], (q) => krunkerPublic.clans.recruitmentBoard(q)),
        },
        turf: {
            status: def("public.turf.status", () => [], () => krunkerPublic.turf.status()),
            clan: def("public.turf.clan", (id: number) => [id], (id) => krunkerPublic.turf.clan(id)),
            clanPlayers: def("public.turf.clanPlayers", (id: number, q: DayMapQuery = {}) => [id, q.day ?? -1, q.map_id ?? -1], (id, q) => krunkerPublic.turf.clanPlayers(id, q)),
            clanEarnings: def("public.turf.clanEarnings", (id: number) => [id], (id) => krunkerPublic.turf.clanEarnings(id)),
            clanPayouts: def("public.turf.clanPayouts", (id: number, day?: number) => [id, day ?? -1], (id, day) => krunkerPublic.turf.clanPayouts(id, day)),
            topClans: def("public.turf.topClans", (q: DayMapQuery & { clan_name?: string } = {}) => [q.day ?? -1, q.map_id ?? -1, lower(q.clan_name ?? "")], (q) => krunkerPublic.turf.topClans(q)),
            topGrossing: def("public.turf.topGrossing", (clanName?: string) => [lower(clanName ?? "")], (clanName) => krunkerPublic.turf.topGrossing(clanName)),
            topPlayers: def("public.turf.topPlayers", (q: { map_id?: number; player_name?: string } = {}) => [q.map_id ?? -1, lower(q.player_name ?? "")], (q) => krunkerPublic.turf.topPlayers(q)),
            player: def("public.turf.player", (id: number) => [id], (id) => krunkerPublic.turf.player(id)),
            playerContributions: def("public.turf.playerContributions", (id: number, day?: number) => [id, day ?? -1], (id, day) => krunkerPublic.turf.playerContributions(id, day)),
            playerEarnings: def("public.turf.playerEarnings", (id: number) => [id], (id) => krunkerPublic.turf.playerEarnings(id)),
        },
        leaderboards: {
            players: def("public.leaderboards.players", (type: PlayerLeaderboardType, q: PlayerLeaderboardQuery = {}) => [type, q.sort ?? "", q.season ?? 0], (type, q) => krunkerPublic.leaderboards.players(type, q)),
            clans: def("public.leaderboards.clans", (sort: ClanLeaderboardSort = "score") => [sort], (sort) => krunkerPublic.leaderboards.clans(sort)),
            raids: def("public.leaderboards.raids", (mapId: number, sort?: RaidSort) => [mapId, sort ?? ""], (mapId, sort) => krunkerPublic.leaderboards.raids(mapId, sort)),
            raidsMonthly: def("public.leaderboards.raidsMonthly", (mapId: number, month: string, sort?: RaidSort) => [mapId, month, sort ?? ""], (mapId, month, sort) => krunkerPublic.leaderboards.raidsMonthly(mapId, month, sort)),
            krunkCupTeams: def("public.leaderboards.krunkCupTeams", () => [], () => krunkerPublic.leaderboards.krunkCupTeams()),
            krunkCupContributors: def("public.leaderboards.krunkCupContributors", (teamId: number) => [teamId], (teamId) => krunkerPublic.leaderboards.krunkCupContributors(teamId)),
            krunkCupPlayers: def("public.leaderboards.krunkCupPlayers", (limit?: number) => [limit ?? 0], (limit) => krunkerPublic.leaderboards.krunkCupPlayers(limit)),
        },
        game: {
            maps: def("public.game.maps", () => [], () => krunkerPublic.game.maps()),
            mapConfig: def("public.game.mapConfig", (mapId: number) => [mapId], (mapId) => krunkerPublic.game.mapConfig(mapId)),
            mapByName: def("public.game.mapByName", (name: string) => [lower(name)], (name) => krunkerPublic.game.mapByName(name)),
            mapLeaderboard: def("public.game.mapLeaderboard", (name: string, q: CommunityLeaderboardQuery = {}) => [lower(name), page(q), q.type ?? "", q.order ?? -1], (name, q) => krunkerPublic.game.mapLeaderboard(name, q)),
            modByName: def("public.game.modByName", (name: string) => [name.trim()], (name) => krunkerPublic.game.modByName(name)),
            titles: def("public.game.titles", () => [], () => krunkerPublic.game.titles()),
            creatorEvents: def("public.game.creatorEvents", () => [], () => krunkerPublic.game.creatorEvents()),
        },
        shop: {
            display: def("public.shop.display", (id: number) => [id], (id) => krunkerPublic.shop.display(id)),
            displayByTag: def("public.shop.displayByTag", (tag: string) => [lower(tag)], (tag) => krunkerPublic.shop.displayByTag(tag)),
            spinWheels: def("public.shop.spinWheels", () => [], () => krunkerPublic.shop.spinWheels()),
            lottery: def("public.shop.lottery", (id: number) => [id], (id) => krunkerPublic.shop.lottery(id)),
        },
        market: {
            stats: def("public.market.stats", (q: MarketStatsQuery = {}) => [q.cursor ?? 0, q.limit ?? 0, q.sort ?? "", q.rarities ?? [], q.weapons ?? [], q.types ?? [], q.season ?? 0, lower(q.searchTerm ?? "")], (q) => krunkerPublic.market.stats(q)),
            itemSales: def("public.market.itemSales", (skinIndex: number) => [skinIndex], (skinIndex) => krunkerPublic.market.itemSales(skinIndex)),
            itemSalesStatistics: def("public.market.itemSalesStatistics", (skinIndex: number, daysBack = 30) => [skinIndex, daysBack], (skinIndex, daysBack) => krunkerPublic.market.itemSalesStatistics(skinIndex, daysBack)),
        },
        items: {
            view: def("public.items.view", (skinIndex: number) => [skinIndex], (skinIndex) => krunkerPublic.items.view(skinIndex)),
            sales: def("public.items.sales", (skinIndex: number, range = 6) => [skinIndex, range], (skinIndex, range) => krunkerPublic.items.sales(skinIndex, range)),
            instances: def("public.items.instances", (skinIndex: number, sort = "mint") => [skinIndex, sort], (skinIndex, sort) => krunkerPublic.items.instances(skinIndex, sort)),
        },
        social: {
            feed: def("public.social.feed", (tab: FeedTab = "global", limit?: number) => [tab, limit ?? 0], (tab, limit) => krunkerPublic.social.feed(tab, limit)),
            post: def("public.social.post", (postId: number) => [postId], (postId) => krunkerPublic.social.post(postId)),
            news: def("public.social.news", () => [], () => krunkerPublic.social.news()),
        },
        matchmaker: {
            gameList: def("public.matchmaker.gameList", () => [], () => krunkerPublic.matchmaker.gameList()),
            pingList: def("public.matchmaker.pingList", () => [], () => krunkerPublic.matchmaker.pingList()),
            gameInfo: def("public.matchmaker.gameInfo", (gameId: string) => [gameId], (gameId) => krunkerPublic.matchmaker.gameInfo(gameId)),
        },
        legacy: {
            mapsList: def("public.legacy.mapsList", (q: BrowserQuery = {}) => [q.index ?? 0, q.pos ?? 0], (q) => krunkerPublic.legacy.mapsList(q)),
            modsList: def("public.legacy.modsList", (q: BrowserQuery = {}) => [q.index ?? 0, q.pos ?? 0], (q) => krunkerPublic.legacy.modsList(q)),
            itemPrices: def("public.legacy.itemPrices", () => [], () => krunkerPublic.legacy.itemPrices()),
            topStreams: def("public.legacy.topStreams", () => [], () => krunkerPublic.legacy.topStreams()),
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
