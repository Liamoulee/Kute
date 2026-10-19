// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// a small in-memory cache for derived replies: one computation per key per ttl, every caller inside the
// window gets the same object, so a route's cost is bounded by its ttl and not by its visitors

type Entry = { value: unknown; at: number; expiresAt: number };

const MAX_ENTRIES = 5000;

export class TtlCache {
    readonly #entries = new Map<string, Entry>();
    readonly #inflight = new Map<string, Promise<unknown>>();

    /** the cached value with the time it was made, or a fresh one from `make` */
    get<T>(key: string, ttlMs: number, make: () => T): { value: T; asOf: number } {
        const now = Date.now();
        const hit = this.#entries.get(key);
        if (hit && hit.expiresAt > now) return { value: hit.value as T, asOf: hit.at };
        const value = make();
        this.#remember(key, { value, at: now, expiresAt: now + ttlMs });
        return { value, asOf: now };
    }

    /** the same for an async maker, callers that arrive while it runs share the promise */
    async getAsync<T>(key: string, ttlMs: number, make: () => Promise<T>): Promise<{ value: T; asOf: number }> {
        const now = Date.now();
        const hit = this.#entries.get(key);
        if (hit && hit.expiresAt > now) return { value: hit.value as T, asOf: hit.at };
        const running = this.#inflight.get(key) as Promise<T> | undefined;
        if (running) return { value: await running, asOf: Date.now() };
        const promise = make();
        this.#inflight.set(key, promise);
        try {
            const value = await promise;
            const at = Date.now();
            this.#remember(key, { value, at, expiresAt: at + ttlMs });
            return { value, asOf: at };
        }
        finally {
            this.#inflight.delete(key);
        }
    }

    delete(key: string): void {
        this.#entries.delete(key);
    }

    /** drops expired entries, returns how many */
    prune(now = Date.now()): number {
        let removed = 0;
        for (const [key, entry] of this.#entries){
            if (entry.expiresAt <= now){
                this.#entries.delete(key);
                removed++;
            }
        }
        return removed;
    }

    #remember(key: string, entry: Entry): void {
        if (this.#entries.size >= MAX_ENTRIES){
            const oldest = this.#entries.keys().next();
            if (!oldest.done) this.#entries.delete(oldest.value);
        }
        this.#entries.delete(key);
        this.#entries.set(key, entry);
    }
}
