import type { KrunkerClient } from "../client";
import * as check from "../validate";
import type { Page, SkinDefinition, Skins } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export const MAX_SKINS_PER_PAGE = 10000;

export type SkinsQuery = Page & {
    /** 100 by default, 10000 at most */
    per_page?: number;
    /** only skins of that ranked season, skins without a season count as season 1 */
    season?: number;
};

export class SkinsApi {
    readonly #client: KrunkerClient;

    constructor(client: KrunkerClient){
        this.#client = client;
    }

    /** GET /api/skins */
    list(query: SkinsQuery = {}): Promise<Skins> {
        return this.#client.get("/api/skins", {
            route: "skins.list",
            query: {
                page: check.page(query.page),
                per_page: check.optionalInt(query.per_page, "per_page", 1, MAX_SKINS_PER_PAGE),
                season: check.optionalInt(query.season, "season", 1),
            },
        });
    }

    /** GET /api/skins/:skinid */
    get(skinIndex: number): Promise<SkinDefinition> {
        return this.#client.get(`/api/skins/${check.int(skinIndex, "skinIndex", 0)}`, { route: "skins.get" });
    }
}
