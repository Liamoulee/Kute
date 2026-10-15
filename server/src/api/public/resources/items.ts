import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import { unwrap } from "../client";
import type { Envelope, ItemSale, ItemView } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

/** the item page of the social market, by skin index */
export class PublicItemsApi {
    readonly #gapi: KrunkerClient;

    constructor(gapi: KrunkerClient){
        this.#gapi = gapi;
    }

    /** GET /items/:id/view, stats plus the top owners */
    view(skinIndex: number): Promise<ItemView> {
        return unwrap(this.#gapi.get<Envelope<ItemView>>(`/items/${check.int(skinIndex, "skinIndex", 0)}/view`, { route: "public.items.view" }));
    }

    /** GET /items/:id/sales, one row per day; range is what the item page sends (6) */
    sales(skinIndex: number, range = 6): Promise<ItemSale[]> {
        return unwrap(this.#gapi.get<Envelope<ItemSale[]>>(`/items/${check.int(skinIndex, "skinIndex", 0)}/sales`, {
            route: "public.items.sales",
            query: { range: check.int(range, "range", 0) },
        }));
    }

    /** GET /items/:id/instances, only ever seen empty; "mint" is the game's default sort */
    instances(skinIndex: number, sort = "mint"): Promise<unknown[]> {
        return unwrap(this.#gapi.get<Envelope<unknown[]>>(`/items/${check.int(skinIndex, "skinIndex", 0)}/instances`, {
            route: "public.items.instances",
            query: { sort: check.text(sort, "sort") },
        }));
    }
}
