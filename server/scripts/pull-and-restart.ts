#!/usr/bin/env bun
import { existsSync } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

const serverDir = path.resolve(import.meta.dir, "..");
const ecosystemPath = path.resolve(serverDir, "pm2.ecosystem.json");
const customPm2Home = process.argv[2];

const pm2 = customPm2Home
    ? `PM2_HOME=${customPm2Home} pm2`
    : "pm2";

const run = (command: string): Promise<void> => new Promise((resolve, reject) => {
    exec(command, { cwd: serverDir, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } }, (error, stdout, stderr) => {
        if (stdout) console.log(stdout.trim());
        if (stderr) console.error(stderr.trim());
        if (error) reject(error);
        else resolve();
    });
});

try {
    console.log("[pull-and-restart] Pulling latest changes from git...");
    await run("git pull");
    console.log("[pull-and-restart] Done.");

    // the market engine is a private checkout inside src/market, see src/marketEngine.ts
    if (existsSync(path.resolve(serverDir, "src/market/.git"))){
        console.log("[pull-and-restart] Pulling the market engine...");
        await run("git -C src/market pull");
        console.log("[pull-and-restart] Done.");
    }
    else console.log("[pull-and-restart] No market engine checkout in src/market, skipping.");

    console.log("[pull-and-restart] Installing dependencies...");
    await run("bun install --frozen-lockfile --production");
    console.log("[pull-and-restart] Done.");

    console.log("[pull-and-restart] Restarting via pm2...");
    await run(`${pm2} startOrReload ${ecosystemPath} --silent`);
    console.log("[pull-and-restart] Done.");

    console.log("[pull-and-restart] Saving pm2 list...");
    await run(`${pm2} save`);
    console.log("[pull-and-restart] Done.");

    console.log("[pull-and-restart] Pull and restart completed successfully.");
}
catch (e){
    console.log("[pull-and-restart] An error occurred:");
    console.error(e);
    console.log("[pull-and-restart] Pull and restart failed.");
    process.exit(1);
}
