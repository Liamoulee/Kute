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

function ensureColumn(table: string, column: string, def: string): void {
    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c: { name: string }) => c.name === column)){
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
}

export function initDb(): void {
    // a development server gets its own file, test reports never end up next to real ones
    const file = isDevelopment ? "data/kute.dev.db" : "data/kute.db";
    db = new Database(file, { create: true });

    db.run("PRAGMA journal_mode = WAL;");

    // One row per auto-detect run a client chose to share. Nothing in here identifies a person or an install:
    // no IP, no account, no install id, and the time is only kept as a day.
    // The columns are what gets filtered and grouped by, the whole (validated) report sits next to them as JSON.
    db.run(`
        CREATE TABLE IF NOT EXISTS autodetect_reports (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            received_day  TEXT NOT NULL,
            kute_version  TEXT NOT NULL,
            run_index     INTEGER NOT NULL DEFAULT 0,
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

    ensureColumn("autodetect_reports", "run_index", "INTEGER NOT NULL DEFAULT 0");
    // added with the detailed report. all nullable: older clients do not send the details
    for (const [column, def] of [
        ["renderer", "TEXT"],
        ["os_build", "TEXT"],
        ["ram_gb", "INTEGER"],
        ["threads", "INTEGER"],
        ["canvas_width", "INTEGER"],
        ["canvas_height", "INTEGER"],
        ["resolution", "REAL"],
        ["hard_flip", "INTEGER"],
        ["throttle", "REAL"],
        ["fps_limit", "INTEGER"],
        ["present_p99", "REAL"],
    ]) ensureColumn("autodetect_reports", column, def);

    db.run(`
        CREATE TABLE IF NOT EXISTS autodetect_failures (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            received_day  TEXT NOT NULL,
            kute_version  TEXT NOT NULL,
            stage         TEXT NOT NULL,
            message       TEXT NOT NULL,
            seconds       REAL NOT NULL
        );
    `);

    Log.done("Database initialized (" + file + ").");
}
