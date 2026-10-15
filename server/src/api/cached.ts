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
// routes use this, never krunker directly: one careless endpoint burns the key's window for every player

/** names are matched case-insensitively by the api, so one entry serves every spelling */
const lower = (name: string): string => name.trim().toLowerCase();
const page = (query: Page): number => query.page ?? 1;

function call<A extends unknown[], R>(route: Route, keyOf: (...args: A) => unknown[], fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return (...args) => apiCache.through(`${route}:${JSON.stringify(keyOf(...args))}`, POLICIES[route], () => fn(...args));
}

export const cached = {
    player: {
        profile: call("player.profile", (name: string) => [lower(name)], (name) => krunker.player.profile(name)),
        inventory: call("player.inventory", (name: string) => [lower(name)], (name) => krunker.player.inventory(name)),
        listings: call("player.listings", (name: string, q: Page = {}) => [lower(name), page(q)], (name, q) => krunker.player.listings(name, q)),
        matches: call("player.matches", (name: string, q: MatchesQuery = {}) => [lower(name), page(q), q.season ?? 0], (name, q) => krunker.player.matches(name, q)),
        posts: call("player.posts", (name: string, q: Page = {}) => [lower(name), page(q)], (name, q) => krunker.player.posts(name, q)),
    },
    match: {
        get: call("match.get", (id: number | string | bigint) => [String(id)], (id) => krunker.match.get(id)),
    },
    clan: {
        profile: call("clan.profile", (name: string) => [lower(name)], (name) => krunker.clan.profile(name)),
        members: call("clan.members", (name: string, q: Page = {}) => [lower(name), page(q)], (name, q) => krunker.clan.members(name, q)),
    },
    leaderboard: {
        ranked: call("leaderboard.ranked", (region: RegionId, q: RankedQuery = {}) => [region, page(q), q.season ?? 0], (region, q) => krunker.leaderboard.ranked(region, q)),
    },
    map: {
        get: call("map.get", (name: string) => [lower(name)], (name) => krunker.map.get(name)),
        featured: call("map.featured", () => [], () => krunker.map.featured()),
        leaderboard: call("map.leaderboard", (name: string, q: Page & MapLeaderboardQuery = {}) => [lower(name), page(q), q.type ?? "", q.order ?? -1], (name, q) => krunker.map.leaderboard(name, q)),
        leaderboardPlayer: call("map.leaderboardPlayer", (name: string, player: string, q: MapLeaderboardQuery = {}) => [lower(name), lower(player), q.type ?? "", q.order ?? -1], (name, player, q) => krunker.map.leaderboardPlayer(name, player, q)),
    },
    mods: {
        list: call("mods.list", (q: Page = {}) => [page(q)], (q) => krunker.mods.list(q)),
        // mod name case handling is unverified, the key keeps the spelling
        get: call("mods.get", (name: string) => [name.trim()], (name) => krunker.mods.get(name)),
    },
    market: {
        skin: call("market.skin", (index: number, q: MarketSkinQuery = {}) => [index, page(q), q.days ?? 30], (index, q) => krunker.market.skin(index, q)),
    },
    skins: {
        list: call("skins.list", (q: SkinsQuery = {}) => [page(q), q.per_page ?? 100, q.season ?? 0], (q) => krunker.skins.list(q)),
        get: call("skins.get", (index: number) => [index], (index) => krunker.skins.get(index)),
    },
};

export { apiCache };
