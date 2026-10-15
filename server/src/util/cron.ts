import cron from "node-cron";
import LogHandler from "./logHandler";
import { cleanupRateLimits } from "./rateLimit";
import { apiCache } from "../api/cache/index";
import Log from "./log";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

const sheduleCrons = async function(): Promise<void> {
    cron.schedule("5 0 * * *", async() => {
        await LogHandler.removeOldLogs();
    }, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    cron.schedule("*/15 * * * *", () => {
        cleanupRateLimits();
    });

    cron.schedule("17 * * * *", () => {
        const removed = apiCache.prune();
        if (removed > 0) Log.debug(`api cache: pruned ${removed} expired entries`);
    });

    const cronCount = cron.getTasks().size;
    Log.done("Scheduled " + cronCount + " Crons.");

    await LogHandler.removeOldLogs();
};

export default sheduleCrons;
