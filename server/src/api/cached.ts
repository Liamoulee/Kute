import { krunker } from "./index";
import { apiCache, POLICIES, type Route } from "./cache/index";
import type { MatchesQuery } from "./resources/player";
import type { RankedQuery } from "./resources/leaderboard";
import type { MapLeaderboardQuery } from "./resources/map";
import type { MarketSkinQuery } from "./resources/market";
import type { SkinsQuery } from "./resources/skins";
import type { Page, RegionId } from "./types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// same shape as krunker, every call goes through the cache with its route's policy.
// routes use this, never krunker directly: one careless endpoint burns the key's window for every player.
//   cached.player.profile("name")   cache first, krunker only when the policy says so
//   refresh.player.profile("name")  always krunker, the reply replaces the cached entry

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
