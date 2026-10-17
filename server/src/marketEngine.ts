import { existsSync } from "node:fs";
import path from "node:path";
import Log from "./util/log";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// the market engine (collector, model, validation) is not part of this repository: src/market/ is a
// gitignored checkout of a private repository. the public server runs complete without it, the market
// routes then answer "unavailable". this file is the whole contract between the two

export type MarketJobStatus = {
    name: string;
    running: boolean;
    lastRun: number | null;
    lastOk: number | null;
    lastMs: number | null;
    runs: number;
    failures: number;
    resumable: boolean;
    note: string | null;
};

export type MarketStatus = {
    collector: boolean;
    jobs: MarketJobStatus[];
    counts: Record<string, number>;
};

export type MarketEngine = {
    /** opens the market database and, where enabled, schedules the collector */
    start(): void;
    status(): MarketStatus;
};

/** the engine when its checkout is present, else null; the path is a variable so the compiler does not look for it */
export async function loadMarketEngine(): Promise<MarketEngine | null> {
    const entry = path.join(import.meta.dir, "market", "index.ts");
    if (!existsSync(entry)){
        Log.info("Market engine is not checked out (src/market), the market routes answer unavailable.");
        return null;
    }
    const specifier = "./market/index.ts";
    try {
        const engine = await import(specifier) as MarketEngine;
        if (typeof engine.start !== "function" || typeof engine.status !== "function") throw new Error("the module does not export start and status");
        return engine;
    }
    catch (err){
        Log.error("Market engine failed to load: " + (err as Error).message, err as Error);
        return null;
    }
}
