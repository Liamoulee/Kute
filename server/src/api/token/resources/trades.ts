import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import { unwrap } from "../../public/client";
import type { Envelope } from "../../public/types";
import type { TradeHistory, TradeHistoryQuery, TradeInventories, TradePlayer } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

const MAX_LIMIT = 100;

/** player to player trades; creating, accepting and cancelling are writes and stay out */
export class TokenTradesApi {
    readonly #gapi: KrunkerClient;
    readonly #auth: Record<string, string>;

    constructor(gapi: KrunkerClient, auth: Record<string, string>){
        this.#gapi = gapi;
        this.#auth = auth;
    }

    /** GET /trades/history, open and completed trades of the player; took 6 s once */
    history(query: TradeHistoryQuery = {}): Promise<TradeHistory> {
        return unwrap(this.#gapi.get<Envelope<TradeHistory>>("/trades/history", {
            route: "token.trades.history",
            headers: this.#auth,
            query: {
                offset: check.optionalInt(query.offset, "offset", 0),
                limit: check.optionalInt(query.limit, "limit", 1, MAX_LIMIT),
                include_open: query.includeOpen === false ? 0 : undefined,
            },
        }));
    }

    /** GET /trades/inventory/:playerId, both inventories side by side (36 KB) */
    inventory(playerId: number): Promise<TradeInventories> {
        return unwrap(this.#gapi.get<Envelope<TradeInventories>>(`/trades/inventory/${check.int(playerId, "playerId", 1)}`, { route: "token.trades.inventory", headers: this.#auth }));
    }

    /** GET /trades/player-search, one player by exact name */
    playerSearch(playerName: string): Promise<TradePlayer> {
        return unwrap(this.#gapi.get<Envelope<TradePlayer>>("/trades/player-search", {
            route: "token.trades.playerSearch",
            headers: this.#auth,
            query: { name: check.text(playerName, "playerName") },
        }));
    }
}
