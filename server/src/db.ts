import { Database } from "bun:sqlite";
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
    db = new Database("data/kute.db", { create: true });

    db.run("PRAGMA journal_mode = WAL;");

    // One row per auto-detect run a client chose to share. Nothing in here identifies a person or an install:
    // no IP, no account, no install id, and the time is only kept as a day.
    // The columns are what gets filtered and grouped by, the whole (validated) report sits next to them as JSON.
    db.run(`
        CREATE TABLE IF NOT EXISTS autodetect_reports (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            received_day  TEXT NOT NULL,
            kute_version  TEXT NOT NULL,
            gpu           TEXT NOT NULL,
            cpu           TEXT NOT NULL,
            hz            INTEGER NOT NULL,
            laptop        INTEGER NOT NULL,
            base_fps      REAL NOT NULL,
            final_fps     REAL,
            regime        TEXT NOT NULL,
            holds_goal    INTEGER NOT NULL,
            changes       INTEGER NOT NULL,
            report        TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS autodetect_reports_gpu ON autodetect_reports (gpu);
        CREATE INDEX IF NOT EXISTS autodetect_reports_day ON autodetect_reports (received_day);
    `);

    Log.done("Database initialized.");
}
