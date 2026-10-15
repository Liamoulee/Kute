import type { KrunkerClient } from "../client";
import * as check from "../validate";
import type { MatchDetails } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export class MatchApi {
    readonly #client: KrunkerClient;

    constructor(client: KrunkerClient){
        this.#client = client;
    }

    /** GET /api/match/:id, ranked matches only */
    get(matchId: number | string | bigint): Promise<MatchDetails> {
        return this.#client.get(`/api/match/${check.id(matchId, "matchId")}`, { route: "match.get" });
    }
}
