import type { KrunkerClient } from "../../client";
import { unwrap } from "../../public/client";
import type { Envelope } from "../../public/types";
import type { DiscordStatus, EmailPreferences, GuestProfile, MePlayer, Usernames, Wallet } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

/** the token's own account: /player, /account, /email, /discord, /guest */
export class TokenPlayerApi {
    readonly #gapi: KrunkerClient;
    readonly #auth: Record<string, string>;

    constructor(gapi: KrunkerClient, auth: Record<string, string>){
        this.#gapi = gapi;
        this.#auth = auth;
    }

    /** GET /player/me */
    me(): Promise<MePlayer> {
        return unwrap(this.#gapi.get<Envelope<MePlayer>>("/player/me", { route: "token.player.me", headers: this.#auth }));
    }

    /** GET /player/wallet, kr and every studio currency */
    wallet(): Promise<Wallet> {
        return unwrap(this.#gapi.get<Envelope<Wallet>>("/player/wallet", { route: "token.player.wallet", headers: this.#auth }));
    }

    /** GET /guest/profile, the stats of a guest token */
    guestProfile(): Promise<GuestProfile> {
        return unwrap(this.#gapi.get<Envelope<GuestProfile>>("/guest/profile", { route: "token.player.guestProfile", headers: this.#auth }));
    }

    /** GET /account/usernames, the active name, reserved names and the rename cooldown */
    usernames(): Promise<Usernames> {
        return unwrap(this.#gapi.get<Envelope<Usernames>>("/account/usernames", { route: "token.player.usernames", headers: this.#auth }));
    }

    /** GET /email/preferences */
    emailPreferences(): Promise<EmailPreferences> {
        return unwrap(this.#gapi.get<Envelope<EmailPreferences>>("/email/preferences", { route: "token.player.emailPreferences", headers: this.#auth }));
    }

    /** GET /discord/status, the linked discord account */
    discordStatus(): Promise<DiscordStatus> {
        return unwrap(this.#gapi.get<Envelope<DiscordStatus>>("/discord/status", { route: "token.player.discordStatus", headers: this.#auth }));
    }
}
