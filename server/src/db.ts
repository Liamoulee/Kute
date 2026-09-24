import { Database } from "bun:sqlite";
import { isDevelopment } from "./util/env";
import Log from "./util/log";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

let db: Database;

export function getDb(): Database {
    return db;
}

export function initDb(): void {
    const file = isDevelopment ? "data/kute.dev.db" : "data/kute.db";
    db = new Database(file, { create: true });

    db.run("PRAGMA journal_mode = WAL;");

    // plain counters only, never rows about anybody
    db.run(`
        CREATE TABLE IF NOT EXISTS stats (
            key    TEXT PRIMARY KEY,
            value  TEXT NOT NULL
        );
    `);

    Log.done("Database initialized (" + file + ").");
}
