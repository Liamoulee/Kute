import fs from "node:fs/promises";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

if (await fs.stat("./config/config.custom.ts").catch(() => false)){
    console.log("Config file already exists. Skipping...");
    process.exit(0);
}

await fs.copyFile("./config/config.template.ts", "./config/config.custom.ts");
