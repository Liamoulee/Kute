import type { KrunkerClient } from "../client";
import * as check from "../validate";
import type { InventoryItem, Page, PlayerListings, PlayerMatches, PlayerPosts, PlayerProfile } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export type MatchesQuery = Page & {
    /** ranked season, all seasons when omitted */
    season?: number;
};

export class PlayerApi {
    readonly #client: KrunkerClient;

    constructor(client: KrunkerClient){
        this.#client = client;
    }

    /** GET /api/player/:playername */
    profile(playerName: string): Promise<PlayerProfile> {
        return this.#client.get(`/api/player/${check.name(playerName, "playerName")}`, { route: "player.profile" });
    }

    /** GET /api/player/:playername/inventory */
    inventory(playerName: string): Promise<InventoryItem[]> {
        return this.#client.get(`/api/player/${check.name(playerName, "playerName")}/inventory`, { route: "player.inventory" });
    }

    /** GET /api/player/:playername/listings, 10 per page, newest first */
    listings(playerName: string, query: Page = {}): Promise<PlayerListings> {
        return this.#client.get(`/api/player/${check.name(playerName, "playerName")}/listings`, {
            route: "player.listings",
            query: { page: check.page(query.page) },
        });
    }

    /** GET /api/player/:playername/matches, ranked only, 10 per page, newest first */
    matches(playerName: string, query: MatchesQuery = {}): Promise<PlayerMatches> {
        return this.#client.get(`/api/player/${check.name(playerName, "playerName")}/matches`, {
            route: "player.matches",
            query: { page: check.page(query.page), season: check.optionalInt(query.season, "season", 1) },
        });
    }

    /** GET /api/player/:playername/posts, 10 per page */
    posts(playerName: string, query: Page = {}): Promise<PlayerPosts> {
        return this.#client.get(`/api/player/${check.name(playerName, "playerName")}/posts`, {
            route: "player.posts",
            query: { page: check.page(query.page) },
        });
    }
}
