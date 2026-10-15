import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import type { LegacyMapList, TopStreams } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

/** api.krunker.io, the old rest api; only the two paths the page calls without a token */
export class PublicLegacyApi {
    readonly #client: KrunkerClient;

    constructor(client: KrunkerClient){
        this.#client = client;
    }

    /** GET /webhooks/general/maps/list, the community map browser; index is the category tab, pos the page */
    mapsList(query: { index?: number; pos?: number } = {}): Promise<LegacyMapList> {
        return this.#client.get<LegacyMapList>("/webhooks/general/maps/list", {
            route: "public.legacy.mapsList",
            query: { index: check.optionalInt(query.index, "index", 0) ?? 0, pos: check.optionalInt(query.pos, "pos", 0) ?? 0 },
        });
    }

    /** GET /streams/top, the menu's stream box plus the running drop campaigns */
    async topStreams(): Promise<TopStreams> {
        const body = await this.#client.get<{ data: TopStreams }>("/streams/top", { route: "public.legacy.topStreams", query: { cb: 2 } });
        return body.data;
    }
}
