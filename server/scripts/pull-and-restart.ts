#!/usr/bin/env bun
import path from "node:path";
import { exec } from "node:child_process";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

// Run on the server by the "deploy server" workflow: bun server/scripts/pull-and-restart.ts [PM2_HOME]
// Pulls, installs what the lockfile says and reloads the PM2 app. The repo also holds the client, whose
// 285 MB libcef.dll lives in Git LFS. The server never needs it, so LFS downloads stay switched off here.

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

    // quick when nothing changed, and it fails loudly when package.json and the lockfile disagree
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
