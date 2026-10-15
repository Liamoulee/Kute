import type { Statement } from "bun:sqlite";
import { getDb } from "../../db";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// sqlite holds every entry and is the truth across restarts, memory only mirrors
// what was read or written recently so a hot key never touches the db

export type Entry = {
    /** json text as it came back, parsed on every read so no caller can mutate the shared copy */
    value: string;
    fetchedAt: number;
    /** after this the row is garbage, the cleanup cron deletes it */
    expiresAt: number;
};

/** entries above this stay out of memory, a skins list with 10000 rows is 2 MB */
const MAX_MEMORY_ENTRY_BYTES = 256 * 1024;
const MAX_MEMORY_ENTRIES = 5000;
/** js strings are two bytes a character */
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

type Row = { value: string; fetched_at: number; expires_at: number };

export class CacheStore {
    readonly #memory = new Map<string, Entry>();
    #memoryBytes = 0;
    #select: Statement<Row, [string]> | null = null;
    #upsert: Statement<void, [string, string, number, number]> | null = null;
    #remove: Statement<void, [string]> | null = null;
    #prune: Statement<void, [number]> | null = null;

    #prepare(): void {
        if (this.#select) return;
        const db = getDb();
        this.#select = db.prepare("SELECT value, fetched_at, expires_at FROM api_cache WHERE key = ?");
        this.#upsert = db.prepare(`
            INSERT INTO api_cache (key, value, fetched_at, expires_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
        `);
        this.#remove = db.prepare("DELETE FROM api_cache WHERE key = ?");
        this.#prune = db.prepare("DELETE FROM api_cache WHERE expires_at < ?");
    }

    get(key: string, now = Date.now()): Entry | null {
        const hot = this.#memory.get(key);
        if (hot){
            if (hot.expiresAt < now){
                this.#forget(key);
                return null;
            }
            // re-insert to make it the newest for the lru order
            this.#memory.delete(key);
            this.#memory.set(key, hot);
            return hot;
        }

        this.#prepare();
        const row = this.#select!.get(key);
        if (!row) return null;
        if (row.expires_at < now){
            this.#remove!.run(key);
            return null;
        }
        const entry = { value: row.value, fetchedAt: row.fetched_at, expiresAt: row.expires_at };
        this.#remember(key, entry);
        return entry;
    }

    set(key: string, entry: Entry): void {
        this.#prepare();
        this.#upsert!.run(key, entry.value, entry.fetchedAt, entry.expiresAt);
        this.#forget(key);
        this.#remember(key, entry);
    }

    delete(key: string): void {
        this.#prepare();
        this.#remove!.run(key);
        this.#forget(key);
    }

    /** drops expired rows, returns how many */
    prune(now = Date.now()): number {
        this.#prepare();
        for (const [key, entry] of this.#memory){
            if (entry.expiresAt < now) this.#forget(key);
        }
        return this.#prune!.run(now).changes;
    }

    memoryStats(): { entries: number; bytes: number } {
        return { entries: this.#memory.size, bytes: this.#memoryBytes };
    }

    #remember(key: string, entry: Entry): void {
        const bytes = entry.value.length * 2;
        if (bytes > MAX_MEMORY_ENTRY_BYTES) return;
        while (this.#memory.size >= MAX_MEMORY_ENTRIES || this.#memoryBytes + bytes > MAX_MEMORY_BYTES){
            const oldest = this.#memory.keys().next();
            if (oldest.done) break;
            this.#forget(oldest.value);
        }
        this.#memory.set(key, entry);
        this.#memoryBytes += bytes;
    }

    #forget(key: string): void {
        const entry = this.#memory.get(key);
        if (!entry) return;
        this.#memory.delete(key);
        this.#memoryBytes -= entry.value.length * 2;
    }
}
