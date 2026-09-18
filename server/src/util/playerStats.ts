import { getDb } from "../db";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

// The three player numbers of /api/health. All of them are plain counters: how many connections are open now,
// the highest that number ever was (with the day), and how many clients ever said "this is my first time".
// No list of who was counted exists anywhere, the client remembers that itself.

let online = 0;
let peak = 0;
let peakDay = "";
let total = 0;

const today = (): string => new Date().toISOString().slice(0, 10);

function read(key: string): string | null {
    return getDb().query<{ value: string }, [string]>("SELECT value FROM stats WHERE key = ?").get(key)?.value ?? null;
}

function write(key: string, value: string): void {
    getDb().run("INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}

export function loadPlayerStats(): void {
    peak = Number(read("peak_online")) || 0;
    peakDay = read("peak_online_day") ?? "";
    total = Number(read("total_players")) || 0;
}

export function connectionOpened(): void {
    online++;
    if (online <= peak) return;
    peak = online;
    peakDay = today();
    write("peak_online", String(peak));
    write("peak_online_day", peakDay);
}

export function connectionClosed(): void {
    online = Math.max(0, online - 1);
}

export function countFirstStart(): void {
    total++;
    write("total_players", String(total));
}

export function playerStats(): { online: number; peak: number; peakDay: string; total: number } {
    return { online, peak, peakDay, total };
}
