// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

// Who runs Kute in which Krunker match, so clients can badge each other. A player is only ever a per-game hash
// (sha256 of game id and name, made by the client), which means nothing outside that match and is gone with it.
// Everything lives in memory: nothing is written, nothing is logged.

/** a client posts every 30 s, three missed posts and the entry is gone */
export const PRESENCE_TTL_MS = 90 * 1000;
/** what the clients are told to wait between posts */
export const PRESENCE_INTERVAL_S = 30;
const MAX_PLAYERS_PER_GAME = 64;
const MAX_GAMES = 20000;

/** "NY:abcde", "FRA:ab12c": a short region code, a colon, a short id */
const GAME_ID = /^[A-Za-z0-9]{1,8}:[A-Za-z0-9]{1,16}$/;
/** 16 bytes of sha256 as lowercase hex */
const PLAYER_HASH = /^[0-9a-f]{32}$/;

const games = new Map<string, Map<string, number>>();

export function isGameId(value: unknown): value is string {
    return typeof value === "string" && GAME_ID.test(value);
}

export function isPlayerHash(value: unknown): value is string {
    return typeof value === "string" && PLAYER_HASH.test(value);
}

/**
 * Records that hash is in game now and returns everybody currently known in that game (including hash).
 */
export function announce(game: string, hash: string, now = Date.now()): string[] {
    let players = games.get(game);
    if (!players){
        if (games.size >= MAX_GAMES) return [hash];
        players = new Map();
        games.set(game, players);
    }
    if (!players.has(hash) && players.size >= MAX_PLAYERS_PER_GAME) return [hash];
    players.set(hash, now + PRESENCE_TTL_MS);

    const present: string[] = [];
    for (const [player, expiresAt] of players){
        if (expiresAt <= now) players.delete(player);
        else present.push(player);
    }
    return present;
}

/**
 * Drops expired players and empty games. Returns how many games are left.
 */
export function cleanupPresence(now = Date.now()): number {
    for (const [game, players] of games){
        for (const [player, expiresAt] of players){
            if (expiresAt <= now) players.delete(player);
        }
        if (players.size === 0) games.delete(game);
    }
    return games.size;
}
