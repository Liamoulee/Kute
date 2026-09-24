import type { Developer } from "./developers";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

const MAX_PLAYERS_PER_GAME = 64;
const MAX_GAMES = 20000;

/** region:id, e.g. "NY:abcde" */
const GAME_ID = /^[A-Za-z0-9]{1,8}:[A-Za-z0-9]{1,16}$/;
/** 16 bytes of sha256 as lowercase hex */
const PLAYER_HASH = /^[0-9a-f]{32}$/;

export type Member = {
    send: (text: string) => void;
    /** "" while the connection is in no game */
    game: string;
    hash: string;
    /** what the proof said, null for everybody else */
    dev: Developer | null;
};

/** [hash, 0] or [hash, 1, {c: clan}] for a dev */
type Entry = [string, 0] | [string, 1, { c: string }];

const games = new Map<string, Set<Member>>();

export function isGameId(value: unknown): value is string {
    return typeof value === "string" && GAME_ID.test(value);
}

export function isPlayerHash(value: unknown): value is string {
    return typeof value === "string" && PLAYER_HASH.test(value);
}

function entry(hash: string, dev: Developer | null): Entry {
    return dev ? [hash, 1, { c: dev.clan }] : [hash, 0];
}

// a dev wins over a plain member with the same hash
function entryOf(players: Set<Member>, hash: string): Entry | null {
    let held = false;
    for (const other of players){
        if (other.hash !== hash) continue;
        if (other.dev) return entry(hash, other.dev);
        held = true;
    }
    return held ? entry(hash, null) : null;
}

/** "+" is an upsert on the client */
function plus(value: Entry): object {
    return value[1] === 1 ? { t: "+", h: value[0], d: 1, c: value[2].c } : { t: "+", h: value[0], d: 0 };
}

/** entries are tiny and this only runs per join/leave */
function same(a: Entry | null, b: Entry | null): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function broadcast(players: Set<Member>, except: Member, message: object): void {
    const text = JSON.stringify(message);
    for (const other of players){
        if (other !== except) other.send(text);
    }
}

export function leave(member: Member): void {
    const { game } = member;
    member.game = "";
    const players = games.get(game);
    if (!players?.delete(member)) return;
    if (players.size === 0){
        games.delete(game);
        return;
    }
    const after = entryOf(players, member.hash);
    // gone for good, or a twin stays. a dev leaving a twin takes the flag along
    if (!after) broadcast(players, member, { t: "-", h: member.hash });
    else if (member.dev) broadcast(players, member, plus(after));
}

// a full game or server gets a roster of one
export function join(member: Member, game: string, hash: string, dev: Developer | null): void {
    if (member.game) leave(member);
    member.hash = hash;
    member.dev = dev;

    let players = games.get(game);
    if (!players && games.size >= MAX_GAMES || players && players.size >= MAX_PLAYERS_PER_GAME){
        member.send(JSON.stringify({ t: "roster", game, players: [entry(hash, dev)] }));
        return;
    }
    if (!players){
        players = new Set();
        games.set(game, players);
    }

    const before = entryOf(players, hash);
    players.add(member);
    member.game = game;
    const after = entryOf(players, hash) as Entry;

    const roster = new Map<string, Entry>();
    for (const other of players){
        const known = roster.get(other.hash);
        if (!known || known[1] === 0 && other.dev) roster.set(other.hash, entry(other.hash, other.dev));
    }
    member.send(JSON.stringify({ t: "roster", game, players: [...roster.values()] }));
    if (!same(before, after)) broadcast(players, member, plus(after));
}
