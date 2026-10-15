import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import { unwrap } from "../../public/client";
import type { Envelope } from "../../public/types";
import type { KpdDemosQuery } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

/** role gated reads: moderators and kpd reviewers; a normal token gets 403 "insufficient permissions" (verified) */
export class TokenStaffApi {
    readonly #gapi: KrunkerClient;
    readonly #auth: Record<string, string>;

    constructor(gapi: KrunkerClient, auth: Record<string, string>){
        this.#gapi = gapi;
        this.#auth = auth;
    }

    /** GET /moderation/chat/:name, a player's chat ban */
    chatBan(playerName: string): Promise<unknown> {
        return unwrap(this.#gapi.get<Envelope<unknown>>(`/moderation/chat/${check.name(playerName, "playerName")}`, { route: "token.staff.chatBan", headers: this.#auth }));
    }

    /** GET /players/:name/reports, 403 "not authorized" for everyone else */
    reports(playerName: string): Promise<unknown> {
        return unwrap(this.#gapi.get<Envelope<unknown>>(`/players/${check.name(playerName, "playerName")}/reports`, { route: "token.staff.reports", headers: this.#auth }));
    }

    /** GET /kpd/demos, the demo review queue */
    kpdDemos(query: KpdDemosQuery = {}): Promise<unknown> {
        return unwrap(this.#gapi.get<Envelope<unknown>>("/kpd/demos", {
            route: "token.staff.kpdDemos",
            headers: this.#auth,
            query: { off: check.optionalInt(query.off, "off", 0), q: query.q },
        }));
    }

    /** GET /kpd/demos/:id, ct is the review ticket the game passes along */
    kpdDemo(demoId: string, ct?: string): Promise<unknown> {
        return unwrap(this.#gapi.get<Envelope<unknown>>(`/kpd/demos/${check.name(demoId, "demoId")}`, { route: "token.staff.kpdDemo", headers: this.#auth, query: { ct } }));
    }

    /** GET /kpd/reviewers */
    kpdReviewers(): Promise<unknown> {
        return unwrap(this.#gapi.get<Envelope<unknown>>("/kpd/reviewers", { route: "token.staff.kpdReviewers", headers: this.#auth }));
    }
}
