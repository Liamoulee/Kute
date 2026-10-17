import type { FastifyInstance } from "fastify";
import { krunker } from "../api/index";
import { apiHealth } from "../api/health";
import type { MarketEngine } from "../marketEngine";
import { createRateLimit } from "../util/rateLimit";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export async function marketRoutes(app: FastifyInstance, options: { engine: MarketEngine | null }): Promise<void> {
    const statusLimit = createRateLimit("market-status", 30, 60_000, "Rate limit exceeded. Max 30 requests per minute.");

    // how the collector is doing: job states and row counts, no market data
    app.get("/market/status", { preHandler: statusLimit }, (_req, reply) => {
        reply.header("Cache-Control", "public, max-age=30");
        const window = krunker.rateLimit().global;
        return {
            available: options.engine !== null,
            ...(options.engine?.status() ?? { collector: false, jobs: [], counts: {} }),
            key: window ? { limit: window.limit, remaining: window.remaining, resetAt: window.resetAt } : null,
            krunker: apiHealth.snapshot(),
        };
    });
}
