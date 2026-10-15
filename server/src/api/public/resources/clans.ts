import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import { unwrap } from "../client";
import type { ClanLootConfig, ClanMotd, ClanPublicProfile, Envelope, RecruitmentBoard, RecruitmentPost } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

const MAX_BOARD_LIMIT = 50;

export type RecruitmentQuery = {
    page?: number;
    /** 20 in the game */
    limit?: number;
    region?: string;
    language?: string;
};

export class PublicClansApi {
    readonly #gapi: KrunkerClient;

    constructor(gapi: KrunkerClient){
        this.#gapi = gapi;
    }

    /** GET /clans/by-name/:name, case-insensitive, the roster has no player ids */
    byName(clanName: string): Promise<ClanPublicProfile> {
        return unwrap(this.#gapi.get<Envelope<ClanPublicProfile>>(`/clans/by-name/${check.name(clanName, "clanName")}`, { route: "public.clans.byName" }));
    }

    /** GET /clans/:id/profile, same reply by id */
    profile(clanId: number): Promise<ClanPublicProfile> {
        return unwrap(this.#gapi.get<Envelope<ClanPublicProfile>>(`/clans/${check.int(clanId, "clanId", 1)}/profile`, { route: "public.clans.profile" }));
    }

    /** GET /clans/:id/loot-config, the turf payout rule */
    lootConfig(clanId: number): Promise<ClanLootConfig> {
        return unwrap(this.#gapi.get<Envelope<ClanLootConfig>>(`/clans/${check.int(clanId, "clanId", 1)}/loot-config`, { route: "public.clans.lootConfig" }));
    }

    /** GET /clans/:id/motd */
    motd(clanId: number): Promise<ClanMotd> {
        return unwrap(this.#gapi.get<Envelope<ClanMotd>>(`/clans/${check.int(clanId, "clanId", 1)}/motd`, { route: "public.clans.motd" }));
    }

    /** GET /clans/:id/recruitment, the clan's own board post */
    recruitment(clanId: number): Promise<RecruitmentPost> {
        return unwrap(this.#gapi.get<Envelope<RecruitmentPost>>(`/clans/${check.int(clanId, "clanId", 1)}/recruitment`, { route: "public.clans.recruitment" }));
    }

    /** GET /clans/recruitment, the recruitment board */
    recruitmentBoard(query: RecruitmentQuery = {}): Promise<RecruitmentBoard> {
        return unwrap(this.#gapi.get<Envelope<RecruitmentBoard>>("/clans/recruitment", {
            route: "public.clans.recruitmentBoard",
            query: {
                page: check.page(query.page),
                limit: check.optionalInt(query.limit, "limit", 1, MAX_BOARD_LIMIT),
                region: query.region,
                language: query.language,
            },
        }));
    }
}
