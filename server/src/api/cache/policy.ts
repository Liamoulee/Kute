// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export type Policy = {
    /** served as is, krunker is not asked */
    fresh: number;
    /** after fresh: served at once while one refresh runs in the background */
    stale: number;
    /** a 404 is remembered this long, so a mistyped name does not cost a request per visitor */
    missing: number;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** after fresh + stale a reply is only served when krunker cannot be asked (down, rate limited); past this it is deleted */
export const GRACE = 2 * DAY;

/**
 * how long each reply may be served, by how fast the data moves. fresh is the only window
 * that costs nothing; stale costs one background request per window per key, never a wait
 */
export const POLICIES = {
    // definitions change with a season, a month at least
    "skins.get": { fresh: 1 * DAY, stale: 7 * DAY, missing: 1 * DAY },
    "skins.list": { fresh: 1 * DAY, stale: 7 * DAY, missing: 1 * DAY },
    // a ranked match is final once played
    "match.get": { fresh: 7 * DAY, stale: 30 * DAY, missing: 10 * MINUTE },
    "map.get": { fresh: 6 * HOUR, stale: 2 * DAY, missing: 1 * HOUR },
    "map.featured": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "map.leaderboard": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 1 * HOUR },
    "map.leaderboardPlayer": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "mods.list": { fresh: 6 * HOUR, stale: 2 * DAY, missing: 1 * HOUR },
    "mods.get": { fresh: 6 * HOUR, stale: 2 * DAY, missing: 1 * HOUR },
    "clan.profile": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "clan.members": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    // every match moves these, a player looks at their own card right after one
    "player.profile": { fresh: 2 * MINUTE, stale: 1 * HOUR, missing: 2 * MINUTE },
    "player.inventory": { fresh: 2 * MINUTE, stale: 1 * HOUR, missing: 2 * MINUTE },
    "player.listings": { fresh: 1 * MINUTE, stale: 30 * MINUTE, missing: 2 * MINUTE },
    "player.matches": { fresh: 2 * MINUTE, stale: 1 * HOUR, missing: 2 * MINUTE },
    "player.posts": { fresh: 5 * MINUTE, stale: 2 * HOUR, missing: 2 * MINUTE },
    "leaderboard.ranked": { fresh: 2 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    // the slow endpoint (seconds), and the one a market view will hit per skin
    "market.skin": { fresh: 1 * MINUTE, stale: 1 * HOUR, missing: 1 * HOUR },
} as const satisfies Record<string, Policy>;

export type Route = keyof typeof POLICIES;
