import type { KrunkerClient } from "../client";
import * as check from "../validate";
import type { Page, RankedLeaderboard, RegionId } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export type RankedQuery = Page & {
    /** season number, current season when omitted or 0 */
    season?: number;
};

export class LeaderboardApi {
    readonly #client: KrunkerClient;

    constructor(client: KrunkerClient){
        this.#client = client;
    }

    /** GET /api/leaderboard/:region, 10 per page, mmr descending, players with 6+ placements only */
    ranked(region: RegionId, query: RankedQuery = {}): Promise<RankedLeaderboard> {
        return this.#client.get(`/api/leaderboard/${check.int(region, "region", 0)}`, {
            route: "leaderboard.ranked",
            query: { page: check.page(query.page), season: check.optionalInt(query.season, "season", 0) },
        });
    }
}
