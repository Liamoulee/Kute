import type { KrunkerClient } from "../client";
import * as check from "../validate";
import type { FeaturedMaps, LeaderboardOrder, LeaderboardType, MapInfo, MapLeaderboard, MapLeaderboardPlayer, Page } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export type MapLeaderboardQuery = {
    /** which built-in board, the map's configured one when omitted */
    type?: LeaderboardType;
    /** the map's order when omitted, else ascending for time and descending for score */
    order?: LeaderboardOrder;
};

export class MapApi {
    readonly #client: KrunkerClient;

    constructor(client: KrunkerClient){
        this.#client = client;
    }

    /** GET /api/map/:mapname, case sensitive, 404 for restricted or deleted maps */
    get(mapName: string): Promise<MapInfo> {
        return this.#client.get(`/api/map/${check.name(mapName, "mapName")}`, { route: "map.get" });
    }

    /** GET /api/maps/featured, newest first */
    featured(): Promise<FeaturedMaps> {
        return this.#client.get("/api/maps/featured", { route: "map.featured" });
    }

    /** GET /api/map/:mapname/leaderboard, 25 per page, empty entries when the map has no board */
    leaderboard(mapName: string, query: Page & MapLeaderboardQuery = {}): Promise<MapLeaderboard> {
        return this.#client.get(`/api/map/${check.name(mapName, "mapName")}/leaderboard`, {
            route: "map.leaderboard",
            query: {
                page: check.page(query.page),
                type: check.leaderboardType(query.type),
                order: check.leaderboardOrder(query.order),
            },
        });
    }

    /** GET /api/map/:mapname/leaderboard/player/:playername, 404 when the player has no entry */
    leaderboardPlayer(mapName: string, playerName: string, query: MapLeaderboardQuery = {}): Promise<MapLeaderboardPlayer> {
        return this.#client.get(`/api/map/${check.name(mapName, "mapName")}/leaderboard/player/${check.name(playerName, "playerName")}`, {
            route: "map.leaderboardPlayer",
            query: {
                type: check.leaderboardType(query.type),
                order: check.leaderboardOrder(query.order),
            },
        });
    }
}
