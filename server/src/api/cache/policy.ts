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
    "game.players.get": { fresh: 2 * MINUTE, stale: 1 * HOUR, missing: 2 * MINUTE },
    "game.players.search": { fresh: 10 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "game.players.sales": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "game.players.listings": { fresh: 1 * MINUTE, stale: 30 * MINUTE, missing: 2 * MINUTE },
    "game.players.followers": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "game.players.following": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "game.players.feed": { fresh: 5 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "game.clans.byName": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "game.clans.profile": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "game.clans.lootConfig": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "game.clans.motd": { fresh: 10 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "game.clans.recruitment": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "game.clans.recruitmentBoard": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 1 * HOUR },
    // turf numbers move all day, the day boundary (utc midnight) matters more than minutes
    "game.turf.status": { fresh: 2 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "game.turf.clan": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "game.turf.clanPlayers": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "game.turf.clanEarnings": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 10 * MINUTE },
    "game.turf.clanPayouts": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 10 * MINUTE },
    "game.turf.topClans": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "game.turf.topGrossing": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 10 * MINUTE },
    "game.turf.topPlayers": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 10 * MINUTE },
    "game.turf.player": { fresh: 10 * MINUTE, stale: 1 * DAY, missing: 10 * MINUTE },
    "game.turf.playerContributions": { fresh: 10 * MINUTE, stale: 1 * DAY, missing: 10 * MINUTE },
    "game.turf.playerEarnings": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 10 * MINUTE },
    "game.leaderboards.players": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "game.leaderboards.clans": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "game.leaderboards.raids": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * DAY },
    "game.leaderboards.raidsMonthly": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * DAY },
    "game.leaderboards.krunkCupTeams": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "game.leaderboards.krunkCupContributors": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "game.leaderboards.krunkCupPlayers": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    // game data changes with a game update
    "game.game.maps": { fresh: 1 * DAY, stale: 7 * DAY, missing: 1 * DAY },
    "game.game.mapConfig": { fresh: 1 * DAY, stale: 7 * DAY, missing: 1 * DAY },
    "game.game.titles": { fresh: 1 * DAY, stale: 7 * DAY, missing: 1 * DAY },
    // the lobby list is live data, the game polls it every 60 s
    "game.matchmaker.gameList": { fresh: 30 * SECOND, stale: 5 * MINUTE, missing: 1 * MINUTE },
    "game.matchmaker.pingList": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "game.matchmaker.gameInfo": { fresh: 15 * SECOND, stale: 2 * MINUTE, missing: 1 * MINUTE },
    "game.legacy.mapsList": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "game.legacy.modsList": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "game.legacy.itemPrices": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "game.legacy.topStreams": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "game.game.mapByName": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "game.game.mapLeaderboard": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 1 * HOUR },
    "game.game.modByName": { fresh: 6 * HOUR, stale: 2 * DAY, missing: 1 * HOUR },
    "game.game.creatorEvents": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    "game.shop.display": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "game.shop.displayByTag": { fresh: 1 * HOUR, stale: 1 * DAY, missing: 1 * HOUR },
    "game.shop.spinWheels": { fresh: 1 * DAY, stale: 7 * DAY, missing: 1 * DAY },
    "game.shop.lottery": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
    // the market moves by the minute, a listing count is only ever a snapshot anyway
    "game.market.stats": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "game.market.itemSales": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "game.market.itemSalesStatistics": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "game.items.view": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "game.items.sales": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "game.items.instances": { fresh: 10 * MINUTE, stale: 2 * HOUR, missing: 10 * MINUTE },
    "game.social.feed": { fresh: 2 * MINUTE, stale: 30 * MINUTE, missing: 10 * MINUTE },
    "game.social.post": { fresh: 5 * MINUTE, stale: 1 * HOUR, missing: 10 * MINUTE },
    "game.social.news": { fresh: 15 * MINUTE, stale: 1 * DAY, missing: 1 * HOUR },
} as const satisfies Record<string, Policy>;

export type Route = keyof typeof POLICIES;
