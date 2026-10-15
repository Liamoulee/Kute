import Log from "../../util/log";
import { isTransient, KrunkerNotFoundError } from "../errors";
import { GRACE, type Policy } from "./policy";
import { CacheStore } from "./store";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export { POLICIES, GRACE, type Policy, type Route } from "./policy";

type Stored<T> = { v: T } | { missing: { url: string; message: string } };

export type CacheStats = {
    /** served within fresh */
    hits: number;
    /** served within stale, a refresh ran behind it */
    stale: number;
    /** served past stale because krunker could not be asked */
    graced: number;
    /** a remembered 404 */
    missing: number;
    /** requests that went to krunker */
    fetched: number;
    /** callers that joined a request already running */
    coalesced: number;
    /** requests to krunker that failed */
    failed: number;
    memory: { entries: number; bytes: number };
};

export class ApiCache {
    readonly #store = new CacheStore();
    readonly #inflight = new Map<string, Promise<unknown>>();
    readonly #stats = { hits: 0, stale: 0, graced: 0, missing: 0, fetched: 0, coalesced: 0, failed: 0 };

    /** the one way through: a cached reply when the policy allows it, else the fetcher, one request per key at a time */
    async through<T>(key: string, policy: Policy, fetcher: () => Promise<T>): Promise<T> {
        const now = Date.now();
        const entry = this.#store.get(key, now);
        if (!entry) return this.#fetch(key, policy, fetcher);

        const stored = JSON.parse(entry.value) as Stored<T>;
        if ("missing" in stored){
            this.#stats.missing++;
            throw new KrunkerNotFoundError(404, stored.missing.url, null, stored.missing.message);
        }

        const age = now - entry.fetchedAt;
        if (age < policy.fresh){
            this.#stats.hits++;
            return stored.v;
        }
        if (age < policy.fresh + policy.stale){
            this.#stats.stale++;
            // the refresh's own failure is logged there, the caller already has a reply
            this.#fetch(key, policy, fetcher).catch(() => undefined);
            return stored.v;
        }

        try {
            return await this.#fetch(key, policy, fetcher);
        }
        catch (err){
            if (!isTransient(err)) throw err;
            this.#stats.graced++;
            Log.debug(`api cache: serving ${key} from ${Math.round(age / 1000)}s ago, ${(err as Error).message}`);
            return stored.v;
        }
    }

    invalidate(key: string): void {
        this.#store.delete(key);
    }

    prune(): number {
        return this.#store.prune();
    }

    stats(): CacheStats {
        return { ...this.#stats, memory: this.#store.memoryStats() };
    }

    #fetch<T>(key: string, policy: Policy, fetcher: () => Promise<T>): Promise<T> {
        const running = this.#inflight.get(key) as Promise<T> | undefined;
        if (running){
            this.#stats.coalesced++;
            return running;
        }

        const request = (async(): Promise<T> => {
            try {
                const value = await fetcher();
                const now = Date.now();
                this.#stats.fetched++;
                this.#store.set(key, { value: JSON.stringify({ v: value }), fetchedAt: now, expiresAt: now + policy.fresh + policy.stale + GRACE });
                return value;
            }
            catch (err){
                this.#stats.failed++;
                if (err instanceof KrunkerNotFoundError){
                    const now = Date.now();
                    const stored: Stored<T> = { missing: { url: err.url, message: err.message } };
                    this.#store.set(key, { value: JSON.stringify(stored), fetchedAt: now, expiresAt: now + policy.missing });
                }
                else Log.debug(`api cache: ${key} failed, ${(err as Error).message}`);
                throw err;
            }
            finally {
                this.#inflight.delete(key);
            }
        })();
        this.#inflight.set(key, request);
        return request;
    }
}

export const apiCache = new ApiCache();
