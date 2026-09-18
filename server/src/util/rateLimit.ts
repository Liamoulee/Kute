import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { isDevelopment } from "./env";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

const salt = randomBytes(32);

type Window = { hits: number; resetAt: number };
const windows = new Map<string, Window>();

function keyFor(name: string, ip: string): string {
    return name + ":" + createHash("sha256").update(salt).update(ip).digest("base64url");
}

export function cleanupRateLimits(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of windows){
        if (entry.resetAt <= now){
            windows.delete(key);
            removed++;
        }
    }
    return removed;
}

/**
 * Creates a rate limit hook for Fastify routes.
 * @param name - Unique name for this limiter
 * @param max - Max requests allowed in the window
 * @param windowMs - Time window in milliseconds
 * @param message - Error message when limit exceeded
 */
export function createRateLimit(name: string, max: number, windowMs: number, message: string) {
    const allowed = isDevelopment ? max * 100 : max;

    return async(req: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const key = keyFor(name, req.ip);
        const now = Date.now();

        let entry = windows.get(key);
        if (!entry || now > entry.resetAt){
            entry = { hits: 0, resetAt: now + windowMs };
            windows.set(key, entry);
        }
        entry.hits++;

        reply.header("X-RateLimit-Limit", allowed);
        reply.header("X-RateLimit-Remaining", Math.max(0, allowed - entry.hits));
        reply.header("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000));

        if (entry.hits > allowed){
            reply.header("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
            reply.code(429).send({
                statusCode: 429,
                error: "Too Many Requests",
                message,
            });
        }
    };
}
