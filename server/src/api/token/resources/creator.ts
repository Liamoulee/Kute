import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import { unwrap } from "../../public/client";
import type { Envelope } from "../../public/types";
import type { MyApplications } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

/** what a creator sees of their own maps and studios, plus the clan applications of the player */
export class TokenCreatorApi {
    readonly #gapi: KrunkerClient;
    readonly #auth: Record<string, string>;

    constructor(gapi: KrunkerClient, auth: Record<string, string>){
        this.#gapi = gapi;
        this.#auth = auth;
    }

    /** GET /clans/my-applications, clan_ids is null without any */
    clanApplications(): Promise<MyApplications> {
        return unwrap(this.#gapi.get<Envelope<MyApplications>>("/clans/my-applications", { route: "token.creator.clanApplications", headers: this.#auth }));
    }

    /** GET /maps/:id/versions, the version history of an own map; empty for a map that is not yours */
    mapVersions(mapId: number): Promise<unknown[]> {
        return unwrap(this.#gapi.get<Envelope<unknown[]>>(`/maps/${check.int(mapId, "mapId", 1)}/versions`, { route: "token.creator.mapVersions", headers: this.#auth }));
    }

    /** GET /maps/:id/data?player=, a map's stored key value data for one player (the kvs of map scripts) */
    mapData(mapId: number, playerName: string): Promise<unknown> {
        return unwrap(this.#gapi.get<Envelope<unknown>>(`/maps/${check.int(mapId, "mapId", 1)}/data`, {
            route: "token.creator.mapData",
            headers: this.#auth,
            query: { player: check.text(playerName, "playerName") },
        }));
    }

    /** GET /studios/mine */
    studios(): Promise<unknown[]> {
        return unwrap(this.#gapi.get<Envelope<unknown[]>>("/studios/mine", { route: "token.creator.studios", headers: this.#auth }));
    }

    /** GET /studios/invites */
    studioInvites(): Promise<unknown[]> {
        return unwrap(this.#gapi.get<Envelope<unknown[]>>("/studios/invites", { route: "token.creator.studioInvites", headers: this.#auth }));
    }

    /** GET /studios/:id */
    studio(studioId: number): Promise<unknown> {
        return unwrap(this.#gapi.get<Envelope<unknown>>(`/studios/${check.int(studioId, "studioId", 1)}`, { route: "token.creator.studio", headers: this.#auth }));
    }

    /** GET /studios/:id/monetization */
    studioMonetization(studioId: number): Promise<unknown> {
        return unwrap(this.#gapi.get<Envelope<unknown>>(`/studios/${check.int(studioId, "studioId", 1)}/monetization`, { route: "token.creator.studioMonetization", headers: this.#auth }));
    }

    /** GET /studios/:id/analytics */
    studioAnalytics(studioId: number): Promise<unknown> {
        return unwrap(this.#gapi.get<Envelope<unknown>>(`/studios/${check.int(studioId, "studioId", 1)}/analytics`, { route: "token.creator.studioAnalytics", headers: this.#auth }));
    }

    /** GET /studios/:id/skins */
    studioSkins(studioId: number): Promise<unknown[]> {
        return unwrap(this.#gapi.get<Envelope<unknown[]>>(`/studios/${check.int(studioId, "studioId", 1)}/skins`, { route: "token.creator.studioSkins", headers: this.#auth }));
    }
}
