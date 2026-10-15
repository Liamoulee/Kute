import type { KrunkerClient } from "../client";
import * as check from "../validate";
import type { ClanMembers, ClanProfile, Page } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export class ClanApi {
    readonly #client: KrunkerClient;

    constructor(client: KrunkerClient){
        this.#client = client;
    }

    /** GET /api/clan/:clanname */
    profile(clanName: string): Promise<ClanProfile> {
        return this.#client.get(`/api/clan/${check.name(clanName, "clanName")}`, { route: "clan.profile" });
    }

    /** GET /api/clan/:clanname/members, 10 per page, role then score descending */
    members(clanName: string, query: Page = {}): Promise<ClanMembers> {
        return this.#client.get(`/api/clan/${check.name(clanName, "clanName")}/members`, {
            route: "clan.members",
            query: { page: check.page(query.page) },
        });
    }
}
