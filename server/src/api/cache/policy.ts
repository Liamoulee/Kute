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

    // keyless endpoints: no documented limit, the game itself calls them, so the same care applies
    "public.players.get": { fresh: 2 * MINUTE, stale: 1 * HOUR, missing: 2 * MINUTE },
    "public.players.search": { fresh: 10 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "public.players.sales": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "public.players.listings": { fresh: 1 * MINUTE, stale: 30 * MINUTE, missing: 2 * MINUTE },
    "public.players.followers": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "public.players.following": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "public.players.feed": { fresh: 5 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "public.clans.byName": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "public.clans.profile": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "public.clans.lootConfig": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "public.clans.motd": { fresh: 10 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "public.clans.recruitment": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "public.clans.recruitmentBoard": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 1 * HOUR },
    // turf numbers move all day, the day boundary (utc midnight) matters more than minutes
    "public.turf.status": { fresh: 2 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "public.turf.clan": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "public.turf.clanPlayers": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "public.turf.clanEarnings": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 10 * MINUTE },
    "public.turf.clanPayouts": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 10 * MINUTE },
    "public.turf.topClans": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "public.turf.topGrossing": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 10 * MINUTE },
    "public.turf.topPlayers": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 10 * MINUTE },
    "public.turf.player": { fresh: 10 * MINUTE, stale: 1 * DAY, missing: 10 * MINUTE },
    "public.turf.playerContributions": { fresh: 10 * MINUTE, stale: 1 * DAY, missing: 10 * MINUTE },
    "public.turf.playerEarnings": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 10 * MINUTE },
    "public.leaderboards.players": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "public.leaderboards.clans": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "public.leaderboards.raids": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * DAY },
    "public.leaderboards.raidsMonthly": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * DAY },
    "public.leaderboards.krunkCupTeams": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "public.leaderboards.krunkCupContributors": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "public.leaderboards.krunkCupPlayers": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    // game data changes with a game update
    "public.game.maps": { fresh: 1 * DAY, stale: 7 * DAY, missing: 1 * DAY },
    "public.game.mapConfig": { fresh: 1 * DAY, stale: 7 * DAY, missing: 1 * DAY },
    "public.game.titles": { fresh: 1 * DAY, stale: 7 * DAY, missing: 1 * DAY },
    // the lobby list is live data, the game polls it every 60 s
    "public.matchmaker.gameList": { fresh: 30 * SECOND, stale: 5 * MINUTE, missing: 1 * MINUTE },
    "public.matchmaker.pingList": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "public.matchmaker.gameInfo": { fresh: 15 * SECOND, stale: 2 * MINUTE, missing: 1 * MINUTE },
    "public.legacy.mapsList": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "public.legacy.modsList": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "public.legacy.itemPrices": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "public.legacy.topStreams": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "public.game.mapByName": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "public.game.mapLeaderboard": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 1 * HOUR },
    "public.game.modByName": { fresh: 6 * HOUR, stale: 2 * DAY, missing: 1 * HOUR },
    "public.game.creatorEvents": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "public.shop.display": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "public.shop.displayByTag": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "public.shop.spinWheels": { fresh: 1 * DAY, stale: 7 * DAY, missing: 1 * DAY },
    "public.shop.lottery": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    // the market moves by the minute, a listing count is only ever a snapshot anyway
    "public.market.stats": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "public.market.itemSales": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "public.market.itemSalesStatistics": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "public.items.view": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "public.items.sales": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "public.items.instances": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "public.social.feed": { fresh: 2 * MINUTE, stale: 30 * MINUTE, missing: 10 * MINUTE },
    "public.social.post": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "public.social.news": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
} as const satisfies Record<string, Policy>;

export type Route = keyof typeof POLICIES;
