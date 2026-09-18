import cron from "node-cron";
import LogHandler from "./logHandler";
import { cleanupRateLimits } from "./rateLimit";
import { cleanupPresence } from "./presence";
import Log from "./log";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
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

    cron.schedule("* * * * *", () => {
        cleanupPresence();
    });

    const cronCount = cron.getTasks().size;
    Log.done("Scheduled " + cronCount + " Crons.");

    // start on Init
    await LogHandler.removeOldLogs();
};

export default sheduleCrons;
