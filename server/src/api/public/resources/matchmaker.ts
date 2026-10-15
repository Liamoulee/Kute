import type { KrunkerClient } from "../../client";
import { KrunkerArgumentError } from "../../errors";
import type { GameList, GameListEntry, PingList } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

const HOSTNAME = "krunker.io";
/** "FRA:4kpj2" */
const GAME_ID = /^[A-Z]{2,5}:[a-z0-9]{3,8}$/;

/** matchmaker.krunker.io, plain json without an envelope; the game polls the list every 60 s */
export class PublicMatchmakerApi {
    readonly #client: KrunkerClient;

    constructor(client: KrunkerClient){
        this.#client = client;
    }

    /** GET /game-list, every public lobby (47 KB) */
    gameList(): Promise<GameList> {
        return this.#client.get<GameList>("/game-list", { route: "public.matchmaker.gameList", query: { hostname: HOSTNAME } });
    }

    /** GET /ping-list, region key -> lobby host to ping */
    pingList(): Promise<PingList> {
        return this.#client.get<PingList>("/ping-list", { route: "public.matchmaker.pingList", query: { hostname: HOSTNAME } });
    }

    /** GET /game-info, one lobby as a game list entry */
    gameInfo(gameId: string): Promise<GameListEntry> {
        if (!GAME_ID.test(gameId)) throw new KrunkerArgumentError(`gameId must look like FRA:4kpj2, got ${String(gameId)}`);
        return this.#client.get<GameListEntry>("/game-info", { route: "public.matchmaker.gameInfo", query: { game: gameId } });
    }
}
