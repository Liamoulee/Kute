import { meta } from "../../../config/config";
import { KrunkerClient } from "../client";
import { GAPI_URL, LEGACY_API_URL } from "../public/client";
import { bearer, decodeToken, type TokenClaims } from "./jwt";
import { TokenCreatorApi } from "./resources/creator";
import { TokenMarketApi } from "./resources/market";
import { TokenPlayerApi } from "./resources/player";
import { TokenRankedApi } from "./resources/ranked";
import { TokenShopApi } from "./resources/shop";
import { TokenStaffApi } from "./resources/staff";
import { TokenTradesApi } from "./resources/trades";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export * from "./types";
export { decodeToken, type TokenClaims } from "./jwt";

export class TokenSession {
    /** who the token belongs to, the key to cache anything read here under */
    readonly claims: TokenClaims;
    readonly player: TokenPlayerApi;
    readonly market: TokenMarketApi;
    readonly trades: TokenTradesApi;
    readonly shop: TokenShopApi;
    readonly creator: TokenCreatorApi;
    readonly staff: TokenStaffApi;
    readonly ranked: TokenRankedApi;

    constructor(gapi: KrunkerClient, legacy: KrunkerClient, token: string, claims: TokenClaims){
        const auth = bearer(token);
        this.claims = claims;
        this.player = new TokenPlayerApi(gapi, auth);
        this.market = new TokenMarketApi(gapi, auth);
        this.trades = new TokenTradesApi(gapi, auth);
        this.shop = new TokenShopApi(gapi, auth);
        this.creator = new TokenCreatorApi(gapi, auth);
        this.staff = new TokenStaffApi(gapi, auth);
        this.ranked = new TokenRankedApi(legacy, auth);
    }
}

/**
 * every read of the game api that needs the player's frvr access token (the jwt the client gets from
 * FRVR.auth.getFreshAccessToken()). the client hands its token to a kute endpoint, the server replays it
 * here and nothing else: the token is never stored, never logged, never used for a write. writes (purchases,
 * listings, trades, follows, posts) exist in the game api and are left out on purpose
 */
export class KrunkerTokenApi {
    readonly #gapi: KrunkerClient;
    readonly #legacy: KrunkerClient;

    constructor(options: { userAgent?: string; timeoutMs?: number; retries?: number; fetch?: typeof fetch } = {}){
        this.#gapi = new KrunkerClient({ ...options, baseUrl: GAPI_URL });
        this.#legacy = new KrunkerClient({ ...options, baseUrl: LEGACY_API_URL });
    }

    /** the resources bound to one token; throws KrunkerTokenError before any request when the token is not a live jwt */
    as(token: string): TokenSession {
        return new TokenSession(this.#gapi, this.#legacy, token, decodeToken(token));
    }
}

export const krunkerToken = new KrunkerTokenApi({ userAgent: `${meta.getName()}/${meta.getVersion()} (+https://kute.lol)` });
