import { config, meta } from "../../config/config";
import Log from "../util/log";
import { KrunkerClient, type ClientOptions } from "./client";
import { ClanApi } from "./resources/clan";
import { LeaderboardApi } from "./resources/leaderboard";
import { MapApi } from "./resources/map";
import { MarketApi } from "./resources/market";
import { MatchApi } from "./resources/match";
import { ModsApi } from "./resources/mods";
import { PlayerApi } from "./resources/player";
import { SkinsApi } from "./resources/skins";
import type { RateLimitState } from "./rateLimit";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export * from "./errors";
export * from "./types";
export type { ClientOptions } from "./client";
export type { RateLimitState, RateLimitWindow } from "./rateLimit";
export type { MatchesQuery } from "./resources/player";
export type { RankedQuery } from "./resources/leaderboard";
export type { MapLeaderboardQuery } from "./resources/map";
export type { MarketSkinQuery } from "./resources/market";
export type { SkinsQuery } from "./resources/skins";

/** one api key, one rate limit window: everything that talks to krunker goes through one instance */
export class KrunkerApi {
    readonly player: PlayerApi;
    readonly match: MatchApi;
    readonly clan: ClanApi;
    readonly leaderboard: LeaderboardApi;
    readonly map: MapApi;
    readonly mods: ModsApi;
    readonly market: MarketApi;
    readonly skins: SkinsApi;
    readonly #client: KrunkerClient;

    constructor(options: ClientOptions){
        this.#client = new KrunkerClient(options);
        this.player = new PlayerApi(this.#client);
        this.match = new MatchApi(this.#client);
        this.clan = new ClanApi(this.#client);
        this.leaderboard = new LeaderboardApi(this.#client);
        this.map = new MapApi(this.#client);
        this.mods = new ModsApi(this.#client);
        this.market = new MarketApi(this.#client);
        this.skins = new SkinsApi(this.#client);
    }

    get configured(): boolean {
        return this.#client.configured;
    }

    /** what the last replies said about the key's window, for a health or admin view */
    rateLimit(): RateLimitState {
        return this.#client.rateLimit.snapshot();
    }
}

export const krunker = new KrunkerApi({
    apiKey: config.krunker_api_token ?? "",
    userAgent: `${meta.getName()}/${meta.getVersion()} (+https://kute.lol)`,
});

if (!krunker.configured) Log.warn("krunker_api_token is not set, every Krunker API call will fail");
