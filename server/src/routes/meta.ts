import type { FastifyInstance } from "fastify";
import { config, meta } from "../../config/config";
import { playerStats } from "../util/playerStats";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

export async function metaRoutes(app: FastifyInstance): Promise<void> {
    // version is the server's, client the client's (shown on the website)
    // players: open connections now, the most there ever were (and the day), and how many clients ever started
    app.get("/health", () => ({
        ok: true,
        name: meta.getName(),
        version: meta.getVersion(),
        client: meta.getClientVersion(),
        players: playerStats(),
    }));

    app.get("/meta", (_req, reply) => {
        reply.header("Cache-Control", "public, max-age=300");
        return { clanTagColors: config.clan_tag_colors };
    });
}
