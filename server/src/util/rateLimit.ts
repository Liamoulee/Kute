import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { isDevelopment } from "./env";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

const salt = randomBytes(32);

type Window = { hits: number; resetAt: number };
const windows = new Map<string, Window>();

// address stand-in, hashed with a per-process salt
export function sourceKey(ip: string): string {
    return createHash("sha256").update(salt).update(ip).digest("base64url");
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

export type Hit = { allowed: boolean; limit: number; remaining: number; resetAt: number };

/** counts one hit on a window keyed by anything (an address hash, a session), development is 100 times looser */
export function hit(name: string, key: string, max: number, windowMs: number, now = Date.now()): Hit {
    const allowed = isDevelopment ? max * 100 : max;
    const id = name + ":" + key;
    let entry = windows.get(id);
    if (!entry || now > entry.resetAt){
        entry = { hits: 0, resetAt: now + windowMs };
        windows.set(id, entry);
    }
    entry.hits++;
    return { allowed: entry.hits <= allowed, limit: allowed, remaining: Math.max(0, allowed - entry.hits), resetAt: entry.resetAt };
}

/** writes the usual headers and, when the hit was one too many, the 429; returns whether the request may go on */
export function applyHit(reply: FastifyReply, result: Hit, message: string, now = Date.now()): boolean {
    reply.header("X-RateLimit-Limit", result.limit);
    reply.header("X-RateLimit-Remaining", result.remaining);
    reply.header("X-RateLimit-Reset", Math.ceil(result.resetAt / 1000));
    if (result.allowed) return true;
    reply.header("Retry-After", Math.ceil((result.resetAt - now) / 1000));
    reply.code(429).send({ statusCode: 429, error: "Too Many Requests", message, resetAt: result.resetAt });
    return false;
}

export function createRateLimit(name: string, max: number, windowMs: number, message: string) {
    return async(req: FastifyRequest, reply: FastifyReply): Promise<void> => {
        applyHit(reply, hit(name, sourceKey(req.ip), max, windowMs), message);
    };
}
