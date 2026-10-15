import type { KrunkerClient } from "../client";
import * as check from "../validate";
import type { Mod, Mods, Page } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export class ModsApi {
    readonly #client: KrunkerClient;

    constructor(client: KrunkerClient){
        this.#client = client;
    }

    /** GET /api/mods, 10 per page, most votes first */
    list(query: Page = {}): Promise<Mods> {
        return this.#client.get("/api/mods", { route: "mods.list", query: { page: check.page(query.page) } });
    }

    /** GET /api/mods/:modname */
    get(modName: string): Promise<Mod> {
        return this.#client.get(`/api/mods/${check.name(modName, "modName")}`, { route: "mods.get" });
    }
}
