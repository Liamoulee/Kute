import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import { unwrap } from "../client";
import type { Envelope, FeedPost, FeedTab, SocialNews, SocialPost } from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

const MAX_FEED = 50;

/** the social feed; a player's own posts are players.feed */
export class PublicSocialApi {
    readonly #gapi: KrunkerClient;

    constructor(gapi: KrunkerClient){
        this.#gapi = gapi;
    }

    /** GET /social/feed?tab=, "global" is the only tab seen; an unknown one is a 400 "invalid feed tab" */
    async feed(tab: FeedTab = "global", limit?: number): Promise<FeedPost[]> {
        const body = await unwrap(this.#gapi.get<Envelope<{ posts: FeedPost[] }>>("/social/feed", {
            route: "public.social.feed",
            query: { tab: check.text(tab, "tab"), limit: check.optionalInt(limit, "limit", 1, MAX_FEED) },
        }));
        return body.posts ?? [];
    }

    /** GET /social/post/:id, one post with its comments */
    post(postId: number): Promise<SocialPost> {
        return unwrap(this.#gapi.get<Envelope<SocialPost>>(`/social/post/${check.int(postId, "postId", 1)}`, { route: "public.social.post" }));
    }

    /** GET /social/news, empty on 2026-10-15 */
    news(): Promise<SocialNews> {
        return unwrap(this.#gapi.get<Envelope<SocialNews>>("/social/news", { route: "public.social.news" }));
    }
}
