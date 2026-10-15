import { KrunkerArgumentError } from "./errors";
import type { LeaderboardOrder, LeaderboardType } from "./types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// checks before a request goes out: a bad argument must not cost a request of the window

const MAX_NAME = 64;

/** a non-empty name for a query value, as given */
export function text(value: string, what: string): string {
    if (typeof value !== "string" || value.trim().length === 0) throw new KrunkerArgumentError(`${what} must be a non-empty string`);
    if (value.length > MAX_NAME) throw new KrunkerArgumentError(`${what} is too long (${value.length} > ${MAX_NAME})`);
    return value;
}

/** a non-empty name for a path segment, url encoded */
export const name = (value: string, what: string): string => encodeURIComponent(text(value, what));

export function int(value: number, what: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isInteger(value) || value < min || value > max){
        throw new KrunkerArgumentError(`${what} must be an integer between ${min} and ${max}, got ${String(value)}`);
    }
    return value;
}

export function optionalInt(value: number | undefined, what: string, min: number, max?: number): number | undefined {
    return value === undefined ? undefined : int(value, what, min, max);
}

export const page = (value: number | undefined): number | undefined => optionalInt(value, "page", 1);

/** match ids are int64; past 2^53 only a string or bigint keeps the digits */
export function id(value: number | string | bigint, what: string): string {
    if (typeof value === "bigint"){
        if (value < 0n) throw new KrunkerArgumentError(`${what} must be positive`);
        return value.toString();
    }
    if (typeof value === "number") return String(int(value, what, 0));
    if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw new KrunkerArgumentError(`${what} must be a positive integer`);
    return value;
}

export function leaderboardType(value: LeaderboardType | undefined): LeaderboardType | undefined {
    if (value === undefined) return undefined;
    if (value !== "score" && value !== "time") throw new KrunkerArgumentError(`type must be "score" or "time", got ${String(value)}`);
    return value;
}

export function leaderboardOrder(value: LeaderboardOrder | undefined): LeaderboardOrder | undefined {
    if (value === undefined) return undefined;
    if (value !== 0 && value !== 1) throw new KrunkerArgumentError(`order must be 0 or 1, got ${String(value)}`);
    return value;
}
