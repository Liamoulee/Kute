import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import type { DailySpinProgress, RankedConnection, RankedLeaderboard, RankedLeaderboardQuery, RankedMatchHistory, RankedMatchHistoryQuery, RankedProfile } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

const MAX_LIMIT = 100;

/** api.krunker.io behind a token: the ranked system's own api, plain {data} without an error field on success */
export class TokenRankedApi {
    readonly #api: KrunkerClient;
    readonly #auth: Record<string, string>;

    constructor(api: KrunkerClient, auth: Record<string, string>){
        this.#api = api;
        this.#auth = auth;
    }

    /** GET /leaderboards/rankings/season/:season[/region/:region], 40 per page in the game; a token is required although the board is public */
    async leaderboard(season: number, query: RankedLeaderboardQuery = {}): Promise<RankedLeaderboard> {
        const region = query.region === undefined ? "" : `/region/${check.int(query.region, "region", 0)}`;
        const body = await this.#api.get<{ data: RankedLeaderboard }>(`/leaderboards/rankings/season/${check.int(season, "season", 1)}${region}`, {
            route: "token.ranked.leaderboard",
            headers: this.#auth,
            query: { limit: check.optionalInt(query.limit, "limit", 1, MAX_LIMIT) ?? 40, offset: check.optionalInt(query.offset, "offset", 0) ?? 0 },
        });
        return body.data;
    }

    /** GET /player-profile/me/season/:season[/region/:region], the player's ranked card with season totals (accuracy included) */
    async profile(season: number, region?: number): Promise<RankedProfile> {
        const suffix = region === undefined ? "" : `/region/${check.int(region, "region", 0)}`;
        const body = await this.#api.get<{ data: RankedProfile }>(`/player-profile/me/season/${check.int(season, "season", 1)}${suffix}`, { route: "token.ranked.profile", headers: this.#auth });
        return body.data;
    }

    /** GET /match-history/me/season/:season/gameMode/:mode/isRanked/:ranked[/region/:region]; the game sends the literal "undefined" as mode for all modes, which the api accepts */
    async matchHistory(season: number, query: RankedMatchHistoryQuery = {}): Promise<RankedMatchHistory> {
        const mode = query.gameMode === undefined ? "undefined" : String(check.int(query.gameMode, "gameMode", 0));
        const ranked = query.isRanked === undefined ? "all" : String(query.isRanked);
        const region = query.region === undefined ? "" : `/region/${check.int(query.region, "region", 0)}`;
        const body = await this.#api.get<{ data: RankedMatchHistory }>(`/match-history/me/season/${check.int(season, "season", 1)}/gameMode/${mode}/isRanked/${ranked}${region}`, {
            route: "token.ranked.matchHistory",
            headers: this.#auth,
            query: { limit: check.optionalInt(query.limit, "limit", 1, MAX_LIMIT) ?? 5, offset: check.optionalInt(query.offset, "offset", 0) ?? 0 },
        });
        return body.data;
    }

    /** GET /ranked/me/connection, the ranked lobby the player is bound to, serverUrl null without one */
    async connection(): Promise<RankedConnection> {
        const body = await this.#api.get<{ data: RankedConnection }>("/ranked/me/connection", { route: "token.ranked.connection", headers: this.#auth });
        return body.data;
    }

    /** GET /daily-spin/progress, the daily spin meter */
    async dailySpin(): Promise<DailySpinProgress> {
        const body = await this.#api.get<{ data: DailySpinProgress }>("/daily-spin/progress", { route: "token.ranked.dailySpin", headers: this.#auth });
        return body.data;
    }
}
