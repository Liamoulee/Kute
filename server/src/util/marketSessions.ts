import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../../config/config";
import { isDevelopment } from "./env";
import { sourceKey } from "./rateLimit";
import Log from "./log";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// market sessions: anonymous, in memory, bound to the address they were issued to. a session is only
// issued against a signature the kute exe makes over a challenge we gave out, with a key derived per
// release from a secret only the release workflow and this server know, so the market is kute's own.
// nothing in here names an account; "logged in" is the exe's word and never verified further

const CHALLENGE_TTL_MS = 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** a lan of kute players behind one address */
const SESSIONS_PER_ADDRESS = 8;
const MAX_CHALLENGES = 10_000;

type Challenge = { address: string; expiresAt: number };
type Session = { address: string; expiresAt: number; version: string };

const challenges = new Map<string, Challenge>();
const sessions = new Map<string, Session>();

const token = (): string => randomBytes(32).toString("base64url");

/** the key a release's exe carries: hmac(master, version) as lowercase hex, used as ascii bytes on both sides */
export function keyForVersion(version: string): string | null {
    const master = config.market.attest_master;
    if (!master) return null;
    return createHmac("sha256", master).update(version).digest("hex");
}

function versionAtLeast(version: string, floor: string): boolean {
    const a = version.split(".").map(Number);
    const b = floor.split(".").map(Number);
    for (let i = 0; i < 3; i++){
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x !== y) return x > y;
    }
    return true;
}

export function pruneSessions(now = Date.now()): number {
    let removed = 0;
    for (const [id, c] of challenges){
        if (c.expiresAt < now){
            challenges.delete(id);
            removed++;
        }
    }
    for (const [id, s] of sessions){
        if (s.expiresAt < now){
            sessions.delete(id);
            removed++;
        }
    }
    return removed;
}

/** step one: a challenge for this address */
export function issueChallenge(ip: string): { challenge: string; expiresIn: number } {
    const now = Date.now();
    if (challenges.size >= MAX_CHALLENGES) pruneSessions(now);
    const challenge = token();
    challenges.set(challenge, { address: sourceKey(ip), expiresAt: now + CHALLENGE_TTL_MS });
    return { challenge, expiresIn: CHALLENGE_TTL_MS / 1000 };
}

export type Attestation = { challenge: string; sig: string | null; version: string; loggedIn: boolean };
export type ConfirmResult = { ok: true; session: string; expiresAt: number } | { ok: false; reason: string };

/** step two: the exe's signature over the challenge buys a session */
export function confirmSession(ip: string, attestation: Attestation): ConfirmResult {
    const now = Date.now();
    const address = sourceKey(ip);
    const pending = challenges.get(attestation.challenge);
    challenges.delete(attestation.challenge);
    if (!pending || pending.expiresAt < now) return { ok: false, reason: "challenge unknown or expired" };
    if (pending.address !== address) return { ok: false, reason: "challenge was issued to another address" };
    if (!attestation.loggedIn) return { ok: false, reason: "not logged in" };
    if (!/^\d+\.\d+\.\d+$/.test(attestation.version)) return { ok: false, reason: "bad version" };

    const key = keyForVersion(attestation.version);
    if (key === null){
        // production without a master never hands out sessions, a development server takes anything
        if (!isDevelopment) return { ok: false, reason: "attestation is not configured" };
        Log.debug("market session: unsigned attestation accepted in development");
    }
    else {
        if (!versionAtLeast(attestation.version, config.market.attest_min_version)) return { ok: false, reason: "this Kute version is too old for the market" };
        if (!attestation.sig) return { ok: false, reason: "unsigned" };
        const expected = createHmac("sha256", key).update(`${attestation.challenge}|${attestation.version}|${attestation.loggedIn ? 1 : 0}`).digest();
        let given: Buffer;
        try {
            given = Buffer.from(attestation.sig, "base64");
        }
        catch {
            return { ok: false, reason: "bad signature" };
        }
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad signature" };
    }

    // the oldest session of the address makes room
    const own = [...sessions].filter(([, s]) => s.address === address).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [id] of own.slice(0, Math.max(0, own.length - SESSIONS_PER_ADDRESS + 1))) sessions.delete(id);

    const session = token();
    const expiresAt = now + SESSION_TTL_MS;
    sessions.set(session, { address, expiresAt, version: attestation.version });
    return { ok: true, session, expiresAt };
}

/** the session when it is valid for this address, else null */
export function checkSession(ip: string, session: string | undefined): Session | null {
    if (!session) return null;
    const found = sessions.get(session);
    if (!found) return null;
    if (found.expiresAt < Date.now() || found.address !== sourceKey(ip)){
        sessions.delete(session);
        return null;
    }
    return found;
}

export function sessionCounts(): { sessions: number; challenges: number } {
    return { sessions: sessions.size, challenges: challenges.size };
}
