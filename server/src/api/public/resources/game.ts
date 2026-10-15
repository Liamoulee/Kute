import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import { unwrap } from "../client";
import type { LeaderboardOrder, LeaderboardType } from "../../types";
import type { CommunityMap, CommunityMapLeaderboard, CreatorEvents, Envelope, MapConfig, ModInfo, OfficialMap, Title } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export type CommunityLeaderboardQuery = { page?: number; type?: LeaderboardType; order?: LeaderboardOrder };

/** the static game data the page loads at start plus the community map and mod records */
export class PublicGameApi {
    readonly #gapi: KrunkerClient;

    constructor(gapi: KrunkerClient){
        this.#gapi = gapi;
    }

    /** GET /maps, the official map list, index = id = preview image number */
    maps(): Promise<OfficialMap[]> {
        return unwrap(this.#gapi.get<Envelope<OfficialMap[]>>("/maps", { route: "public.game.maps" }));
    }

    /** GET /maps/:id, the whole map file (120 KB for Burg) */
    mapConfig(mapId: number): Promise<MapConfig> {
        return unwrap(this.#gapi.get<Envelope<MapConfig>>(`/maps/${check.int(mapId, "mapId", 0)}`, { route: "public.game.mapConfig" }));
    }

    /** GET /maps/by-name/:name, the community map record; "Burg" resolves to a community map of that name, not the official one */
    mapByName(mapName: string): Promise<CommunityMap> {
        return unwrap(this.#gapi.get<Envelope<CommunityMap>>(`/maps/by-name/${check.name(mapName, "mapName")}`, { route: "public.game.mapByName" }));
    }

    /** GET /maps/by-name/:name/leaderboard, 25 per page */
    mapLeaderboard(mapName: string, query: CommunityLeaderboardQuery = {}): Promise<CommunityMapLeaderboard> {
        return unwrap(this.#gapi.get<Envelope<CommunityMapLeaderboard>>(`/maps/by-name/${check.name(mapName, "mapName")}/leaderboard`, {
            route: "public.game.mapLeaderboard",
            query: { page: check.page(query.page) ?? 1, type: check.leaderboardType(query.type), order: check.leaderboardOrder(query.order) },
        }));
    }

    /** GET /mods/by-name/:name */
    modByName(modName: string): Promise<ModInfo> {
        return unwrap(this.#gapi.get<Envelope<ModInfo>>(`/mods/by-name/${check.name(modName, "modName")}`, { route: "public.game.modByName" }));
    }

    /** GET /titles, every player title with its requirement */
    titles(): Promise<Title[]> {
        return unwrap(this.#gapi.get<Envelope<Title[]>>("/titles", { route: "public.game.titles" }));
    }

    /** GET /creators/events, upcoming events and the running surveys */
    creatorEvents(): Promise<CreatorEvents> {
        return unwrap(this.#gapi.get<Envelope<CreatorEvents>>("/creators/events", { route: "public.game.creatorEvents" }));
    }
}
