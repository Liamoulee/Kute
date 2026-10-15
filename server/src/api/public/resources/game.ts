import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import { unwrap } from "../client";
import type { Envelope, MapConfig, OfficialMap, Title } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

/** the static game data the page loads at start: official maps, map files, titles */
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

    /** GET /titles, every player title with its requirement */
    titles(): Promise<Title[]> {
        return unwrap(this.#gapi.get<Envelope<Title[]>>("/titles", { route: "public.game.titles" }));
    }
}
