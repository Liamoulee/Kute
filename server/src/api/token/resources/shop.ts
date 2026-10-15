import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import { unwrap } from "../../public/client";
import type { Envelope } from "../../public/types";
import type { CustomSkin, CustomSkinsPage, CustomSkinsQuery, RankedShop, WildOffer, Wristband } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

const MAX_PAGE_SIZE = 100;

/** per player shop state and the player's own custom skins (the editor's /skins) */
export class TokenShopApi {
    readonly #gapi: KrunkerClient;
    readonly #auth: Record<string, string>;

    constructor(gapi: KrunkerClient, auth: Record<string, string>){
        this.#gapi = gapi;
        this.#auth = auth;
    }

    /** GET /ranked/shop, with the player's purchase counts */
    ranked(): Promise<RankedShop> {
        return unwrap(this.#gapi.get<Envelope<RankedShop>>("/ranked/shop", { route: "token.shop.ranked", headers: this.#auth }));
    }

    /** GET /shop/wild-offer, a 200 with {error} inside data when there is none */
    wildOffer(): Promise<WildOffer> {
        return unwrap(this.#gapi.get<Envelope<WildOffer>>("/shop/wild-offer", { route: "token.shop.wildOffer", headers: this.#auth }));
    }

    /** GET /krunkcup/wristband, the player's wristband skin and whether it was claimed */
    wristband(): Promise<Wristband> {
        return unwrap(this.#gapi.get<Envelope<Wristband>>("/krunkcup/wristband", { route: "token.shop.wristband", headers: this.#auth }));
    }

    /** GET /skins, the player's custom skins */
    customSkins(query: CustomSkinsQuery = {}): Promise<CustomSkinsPage> {
        return unwrap(this.#gapi.get<Envelope<CustomSkinsPage>>("/skins", {
            route: "token.shop.customSkins",
            headers: this.#auth,
            query: {
                page: check.page(query.page),
                page_size: check.optionalInt(query.page_size, "page_size", 1, MAX_PAGE_SIZE),
                type: check.optionalInt(query.type, "type", 0),
                weapon: check.optionalInt(query.weapon, "weapon", 0),
                search: query.search,
            },
        }));
    }

    /** GET /skins/:id, one custom skin */
    customSkin(skinId: number): Promise<CustomSkin> {
        return unwrap(this.#gapi.get<Envelope<CustomSkin>>(`/skins/${check.int(skinId, "skinId", 1)}`, { route: "token.shop.customSkin", headers: this.#auth }));
    }
}
