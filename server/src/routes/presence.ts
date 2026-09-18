import type { FastifyInstance } from "fastify";
import { createRateLimit } from "../util/rateLimit";
import { announce, isGameId, isPlayerHash, PRESENCE_INTERVAL_S } from "../util/presence";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

export async function presenceRoutes(app: FastifyInstance): Promise<void> {
    // one post every 30 s plus a few extra when somebody joins the match
    const limit = createRateLimit("presence", 12, 60 * 1000, "Rate limit exceeded. Max 12 presence updates per minute.");

    // the heartbeat and the lookup are the same request: "I am in this game" answers with everybody in it
    app.post("/", { bodyLimit: 1024, onRequest: limit }, (req, reply) => {
        const body = req.body as Record<string, unknown> | null;
        const game = body?.game;
        const hash = body?.hash;
        if (!isGameId(game) || !isPlayerHash(hash)){
            return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "expected a game id and a player hash" });
        }
        reply.header("Cache-Control", "no-store");
        return { players: announce(game, hash), interval: PRESENCE_INTERVAL_S };
    });
}
