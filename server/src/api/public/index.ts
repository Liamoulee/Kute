import { meta } from "../../../config/config";
import { KrunkerClient } from "../client";
import { GAPI_URL, LEGACY_API_URL, MATCHMAKER_URL } from "./client";
import { PublicClansApi } from "./resources/clans";
import { PublicGameApi } from "./resources/game";
import { PublicLeaderboardsApi } from "./resources/leaderboards";
import { PublicLegacyApi } from "./resources/legacy";
import { PublicMatchmakerApi } from "./resources/matchmaker";
import { PublicPlayersApi } from "./resources/players";
import { PublicTurfApi } from "./resources/turf";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export * from "./types";
export { TURF_EPOCH_UTC, TURF_MAPS, turfDay, type DayMapQuery } from "./resources/turf";
export type { RecruitmentQuery } from "./resources/clans";
export type { PlayerLeaderboardQuery } from "./resources/leaderboards";

/**
 * the endpoints the game itself calls without a token: no key, no documented limits, shapes from live replies.
 * read only on purpose, every write of the game api needs the player's own frvr token and never belongs on a server
 */
export class KrunkerPublicApi {
    readonly players: PublicPlayersApi;
    readonly clans: PublicClansApi;
    readonly turf: PublicTurfApi;
    readonly leaderboards: PublicLeaderboardsApi;
    readonly game: PublicGameApi;
    readonly matchmaker: PublicMatchmakerApi;
    readonly legacy: PublicLegacyApi;

    constructor(options: { userAgent?: string; timeoutMs?: number; retries?: number; fetch?: typeof fetch } = {}){
        const gapi = new KrunkerClient({ ...options, baseUrl: GAPI_URL });
        this.players = new PublicPlayersApi(gapi);
        this.clans = new PublicClansApi(gapi);
        this.turf = new PublicTurfApi(gapi);
        this.leaderboards = new PublicLeaderboardsApi(gapi);
        this.game = new PublicGameApi(gapi);
        this.matchmaker = new PublicMatchmakerApi(new KrunkerClient({ ...options, baseUrl: MATCHMAKER_URL }));
        this.legacy = new PublicLegacyApi(new KrunkerClient({ ...options, baseUrl: LEGACY_API_URL }));
    }
}

export const krunkerPublic = new KrunkerPublicApi({ userAgent: `${meta.getName()}/${meta.getVersion()} (+https://kute.lol)` });
