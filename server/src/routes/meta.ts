import type { FastifyInstance } from "fastify";
import { config, meta } from "../../config/config";
import { playerStats } from "../util/playerStats";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

export async function metaRoutes(app: FastifyInstance): Promise<void> {
    // players: open connections now, the most there ever were (and the day), and how many clients ever started
    app.get("/health", () => ({ ok: true, name: meta.getName(), version: meta.getVersion(), players: playerStats() }));

    app.get("/meta", (_req, reply) => {
        reply.header("Cache-Control", "public, max-age=300");
        return { clanTagColors: config.clan_tag_colors };
    });
}
