import type { KrunkerClient } from "../client";
import * as check from "../validate";
import type { MarketSkin, Page } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export const MAX_HISTORY_DAYS = 120;

export type MarketSkinQuery = Page & {
    /** days of price history, 30 by default, 120 at most */
    days?: number;
};

export class MarketApi {
    readonly #client: KrunkerClient;

    constructor(client: KrunkerClient){
        this.#client = client;
    }

    /** GET /api/market/skin/:skinindex, listings 10 per page cheapest first */
    skin(skinIndex: number, query: MarketSkinQuery = {}): Promise<MarketSkin> {
        return this.#client.get(`/api/market/skin/${check.int(skinIndex, "skinIndex", 0)}`, {
            route: "market.skin",
            query: { page: check.page(query.page), days: check.optionalInt(query.days, "days", 1, MAX_HISTORY_DAYS) },
        });
    }
}
