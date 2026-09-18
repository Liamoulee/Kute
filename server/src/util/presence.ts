// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

// Who runs Kute in which Krunker match, so clients can badge each other. Pushed, not polled: a client joins a
// match over its WebSocket once, gets the roster, and from then on only hears who came and who went.
// A player is only ever a per-game hash (sha256 of game id and name, made by the client), which means nothing
// outside that match. Everything lives in memory: nothing is written, nothing is logged.

const MAX_PLAYERS_PER_GAME = 64;
const MAX_GAMES = 20000;

/** "NY:abcde", "FRA:ab12c": a short region code, a colon, a short id */
const GAME_ID = /^[A-Za-z0-9]{1,8}:[A-Za-z0-9]{1,16}$/;
/** 16 bytes of sha256 as lowercase hex */
const PLAYER_HASH = /^[0-9a-f]{32}$/;

/** one connection, as far as the rooms care */
export type Member = {
    send: (text: string) => void;
    /** "" while the connection is in no game */
    game: string;
    hash: string;
};

const games = new Map<string, Set<Member>>();

export function isGameId(value: unknown): value is string {
    return typeof value === "string" && GAME_ID.test(value);
}

export function isPlayerHash(value: unknown): value is string {
    return typeof value === "string" && PLAYER_HASH.test(value);
}

/**
 * Whether another connection in the same game stands for the same player (a reconnect overlapping its old socket).
 */
function hasTwin(member: Member, players: Set<Member>): boolean {
    for (const other of players){
        if (other !== member && other.hash === member.hash) return true;
    }
    return false;
}

function broadcast(players: Set<Member>, except: Member, message: object): void {
    const text = JSON.stringify(message);
    for (const other of players){
        if (other !== except) other.send(text);
    }
}

/**
 * Takes the member out of its game and tells the others.
 */
export function leave(member: Member): void {
    const { game } = member;
    member.game = "";
    const players = games.get(game);
    if (!players?.delete(member)) return;
    if (players.size === 0){
        games.delete(game);
        return;
    }
    if (!hasTwin(member, players)) broadcast(players, member, { t: "-", h: member.hash });
}

/**
 * Puts the member into a game (leaving the one it was in), sends it the roster and tells the others.
 * A full game or a full server answers with a roster of one: the client works, it just sees nobody.
 */
export function join(member: Member, game: string, hash: string): void {
    if (member.game) leave(member);
    member.hash = hash;

    let players = games.get(game);
    if (!players && games.size >= MAX_GAMES || players && players.size >= MAX_PLAYERS_PER_GAME){
        member.send(JSON.stringify({ t: "roster", game, players: [hash] }));
        return;
    }
    if (!players){
        players = new Set();
        games.set(game, players);
    }

    const known = hasTwin(member, players);
    players.add(member);
    member.game = game;

    const roster = new Set<string>();
    for (const other of players) roster.add(other.hash);
    member.send(JSON.stringify({ t: "roster", game, players: [...roster] }));
    if (!known) broadcast(players, member, { t: "+", h: hash });
}
