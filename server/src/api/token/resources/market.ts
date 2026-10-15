import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import { unwrap } from "../../public/client";
import type { Envelope } from "../../public/types";
import type { BlackMarket, BlackMarketRank, InventoryItem, MarketHistory, MarketHistoryQuery, MarketListings, MarketListingsQuery } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

const LISTINGS_SORTS = ["latest", "price_asc", "price_desc", "popular"] as const;
const HISTORY_SORTS = ["date_asc", "date_desc", "amount_asc", "amount_desc", "item_asc", "item_desc"] as const;
const MAX_LIMIT = 100;

/** the market behind a login: listings, the player's inventory, sales and history, the black market */
export class TokenMarketApi {
    readonly #gapi: KrunkerClient;
    readonly #auth: Record<string, string>;

    constructor(gapi: KrunkerClient, auth: Record<string, string>){
        this.#gapi = gapi;
        this.#auth = auth;
    }

    /** GET /market/listings, what the market tab shows; a token is required although the data is not about the player */
    listings(query: MarketListingsQuery = {}): Promise<MarketListings> {
        return unwrap(this.#gapi.get<Envelope<MarketListings>>("/market/listings", {
            route: "token.market.listings",
            headers: this.#auth,
            query: {
                item_id: check.optionalInt(query.item_id, "item_id", 0),
                items: check.list(query.items),
                sort: check.oneOf(query.sort, LISTINGS_SORTS, "sort"),
                cursor_id: check.optionalInt(query.cursor_id, "cursor_id", 0),
                limit: check.optionalInt(query.limit, "limit", 1, MAX_LIMIT),
                rarities: check.list(query.rarities),
                weapons: check.list(query.weapons),
                types: check.list(query.types),
                wears: check.list(query.wears),
                season: check.optionalInt(query.season, "season", 1),
                painted: query.painted ? 1 : undefined,
                searchTerm: query.searchTerm,
            },
        }));
    }

    /** GET /market/inventory, the player's stacks (411 rows for the owner) */
    inventory(): Promise<InventoryItem[]> {
        return unwrap(this.#gapi.get<Envelope<InventoryItem[]>>("/market/inventory", { route: "token.market.inventory", headers: this.#auth }));
    }

    /** GET /market/sales, the player's open listings; only seen empty */
    sales(): Promise<unknown[]> {
        return unwrap(this.#gapi.get<Envelope<unknown[]>>("/market/sales", { route: "token.market.sales", headers: this.#auth }));
    }

    /** GET /market/history, the player's completed buys and sells, newest first by default */
    history(query: MarketHistoryQuery = {}): Promise<MarketHistory> {
        return unwrap(this.#gapi.get<Envelope<MarketHistory>>("/market/history", {
            route: "token.market.history",
            headers: this.#auth,
            query: {
                sort: check.oneOf(query.sort, HISTORY_SORTS, "sort"),
                cursor: check.optionalInt(query.cursor, "cursor", 0),
                limit: check.optionalInt(query.limit, "limit", 1, MAX_LIMIT),
            },
        }));
    }

    /** GET /market/black-market, the skin indices on offer */
    blackMarket(): Promise<BlackMarket> {
        return unwrap(this.#gapi.get<Envelope<BlackMarket>>("/market/black-market", { route: "token.market.blackMarket", headers: this.#auth }));
    }

    /** GET /market/black-market/rank, the player's peak mmr for the ranked tier of the black market */
    blackMarketRank(): Promise<BlackMarketRank> {
        return unwrap(this.#gapi.get<Envelope<BlackMarketRank>>("/market/black-market/rank", { route: "token.market.blackMarketRank", headers: this.#auth }));
    }
}
