import fs from "node:fs/promises";
import Log from "../src/util/log";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

const isObject = (item: unknown): boolean => !!item && typeof item === "object" && !Array.isArray(item);

/**
 * Deep Merge of two objects
 */
const deepMerge = function<T, T2>(target: T, source: T2 & Partial<T>): T & T2{
    if (isObject(target) && isObject(source)){
        const src = source as Record<string, unknown>;
        const tgt = target as Record<string, unknown>;
        for (const key in src){
            if (isObject(src[key])){
                if (!tgt[key]) tgt[key] = {};
                deepMerge(tgt[key] as Record<string, unknown>, src[key] as Record<string, unknown>);
            }
            else tgt[key] = src[key];
        }
    }
    return target as T & T2;
};

try {
    await fs.access("./config/config.custom.ts");
}
catch {
    Log.error("Config file not found. To create one, either copy 'config.template.ts' and rename it to 'config.custom.ts' or run 'npm run generate-config'.");
    process.exit(1);
}

try {
    await fs.access("./config/config.template.ts");
}
catch {
    Log.error("Config template file not found. This is needed to read default values. Please re-clone the repository.");
    process.exit(1);
}

const configCustom = (await import("./config.custom.ts")).default;
const configBase = (await import("./config.template.ts")).default;
const packageJSON = JSON.parse(await fs.readFile("./package.json", "utf-8"));

export const meta = {
    getVersion: (): string => packageJSON.version,
    getName: (): string => packageJSON.name,
    getAuthor: (): string => packageJSON.author,

};

export const config = {
    ...deepMerge(
        configBase,
        configCustom as Partial<typeof configBase>,
    ),
};
