import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import { unwrap } from "../client";
import type { Envelope, FeedPost, PlayerFollow, PlayerSale, PlayerSearchResult, PlayerSocialProfile } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

const MAX_SEARCH = 20;
const MAX_FEED = 50;

export class PublicPlayersApi {
    readonly #gapi: KrunkerClient;

    constructor(gapi: KrunkerClient){
        this.#gapi = gapi;
    }

    /** GET /players/:name, case-insensitive, 404 "player not found" */
    get(playerName: string): Promise<PlayerSocialProfile> {
        return unwrap(this.#gapi.get<Envelope<PlayerSocialProfile>>(`/players/${check.name(playerName, "playerName")}`, { route: "public.players.get" }));
    }

    /** GET /players/search, prefix match on the name */
    async search(query: string, limit = 5): Promise<PlayerSearchResult[]> {
        const body = await unwrap(this.#gapi.get<Envelope<{ results: PlayerSearchResult[] }>>("/players/search", {
            route: "public.players.search",
            query: { q: check.text(query, "query"), limit: check.int(limit, "limit", 1, MAX_SEARCH) },
        }));
        return body.results ?? [];
    }

    /** GET /players/:name/sales, one row per day with market sales: f = kr earned, t = items sold, d = date */
    sales(playerName: string, range = 3): Promise<PlayerSale[]> {
        return unwrap(this.#gapi.get<Envelope<PlayerSale[]>>(`/players/${check.name(playerName, "playerName")}/sales`, {
            route: "public.players.sales",
            query: { range: check.int(range, "range", 1) },
        }));
    }

    /** GET /players/:name/listings, only ever seen empty, the developer api has the real one */
    listings(playerName: string): Promise<unknown[]> {
        return unwrap(this.#gapi.get<Envelope<unknown[]>>(`/players/${check.name(playerName, "playerName")}/listings`, { route: "public.players.listings" }));
    }

    /** GET /players/:name/followers, 100 at most */
    followers(playerName: string): Promise<PlayerFollow[]> {
        return unwrap(this.#gapi.get<Envelope<PlayerFollow[]>>(`/players/${check.name(playerName, "playerName")}/followers`, { route: "public.players.followers" }));
    }

    /** GET /players/:name/following */
    following(playerName: string): Promise<PlayerFollow[]> {
        return unwrap(this.#gapi.get<Envelope<PlayerFollow[]>>(`/players/${check.name(playerName, "playerName")}/following`, { route: "public.players.following" }));
    }

    /** GET /social/feed, a player's posts */
    async feed(playerId: number, limit = 20): Promise<FeedPost[]> {
        const body = await unwrap(this.#gapi.get<Envelope<{ posts: FeedPost[] }>>("/social/feed", {
            route: "public.players.feed",
            query: { player_id: check.int(playerId, "playerId", 1), limit: check.int(limit, "limit", 1, MAX_FEED) },
        }));
        return body.posts ?? [];
    }
}
