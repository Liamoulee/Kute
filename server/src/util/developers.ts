import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config/config";
import Log from "./log";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

export type Developer = { clan: string };

const MIN_TOKEN = 32;
const MAX_USER = 32;
/** the tag inside the brackets, as Krunker renders it */
const CLAN_TAG = /^[^[\]\s]{1,16}$/;
const PROOF = /^[0-9a-f]{64}$/;

const developers = new Map<string, { token: string, clan: string }>();

for (const [user, entry] of Object.entries(config.developers ?? {})){
    if (!user || user.length > MAX_USER){
        Log.warn(`developers: "${user}" is not a usable username, entry ignored`);
        continue;
    }
    if (typeof entry?.token !== "string" || entry.token.length < MIN_TOKEN){
        Log.warn(`developers: "${user}" has no token of at least ${MIN_TOKEN} characters, entry ignored`);
        continue;
    }
    if (typeof entry.clan !== "string" || !CLAN_TAG.test(entry.clan)){
        Log.warn(`developers: "${user}" has no clan tag, entry ignored. The badge is bound to the tag, so it cannot be left out`);
        continue;
    }
    developers.set(user.toLowerCase(), { token: entry.token, clan: entry.clan });
}

if (developers.size > 0) Log.info(`${developers.size} developer(s) configured`);

// anything not exactly right is a plain member, no error, no hint
export function developerOf(claim: unknown, nonce: string, game: string, hash: string): Developer | null {
    if (developers.size === 0 || typeof claim !== "object" || claim === null) return null;
    const { user, proof } = claim as Record<string, unknown>;
    if (typeof user !== "string" || user.length > MAX_USER || typeof proof !== "string" || !PROOF.test(proof)) return null;

    const entry = developers.get(user.toLowerCase());
    if (!entry) return null;

    const expected = createHmac("sha256", entry.token).update(`${nonce}\n${game}\n${hash}`).digest();
    // both 32 bytes after the checks above, never throws
    if (!timingSafeEqual(expected, Buffer.from(proof, "hex"))) return null;
    return { clan: entry.clan };
}
