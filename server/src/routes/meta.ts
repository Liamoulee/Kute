import type { FastifyInstance } from "fastify";
import { config, meta } from "../../config/config";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

export async function metaRoutes(app: FastifyInstance): Promise<void> {
    app.get("/health", () => ({ ok: true, name: meta.getName(), version: meta.getVersion() }));

    // what the client shows that does not ship with it
    app.get("/meta", (_req, reply) => {
        reply.header("Cache-Control", "public, max-age=300");
        return { clanTagColors: config.clan_tag_colors };
    });
}
