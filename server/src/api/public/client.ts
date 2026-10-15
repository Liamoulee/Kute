import { KrunkerError } from "../errors";
import type { Envelope } from "./types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export const GAPI_URL = "https://gapi.svc.krunker.io";
export const MATCHMAKER_URL = "https://matchmaker.krunker.io";
export const LEGACY_API_URL = "https://api.krunker.io";

/** gapi wraps every reply in {data, error}; a 2xx with an error set has not been seen, but the game code checks it */
export async function unwrap<T>(reply: Promise<Envelope<T>>): Promise<T> {
    const body = await reply;
    if (body.error !== null && body.error !== undefined){
        const message = typeof body.error === "string" ? body.error : body.error.message ?? body.error.code ?? "unknown error";
        throw new KrunkerError(`Krunker gapi error: ${message}`);
    }
    return body.data;
}
