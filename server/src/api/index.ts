import { Krunker } from "krapio";
import { config, meta } from "../../config/config";
import Log from "../util/log";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export * from "krapio";

/** one api key, one rate limit window: everything that talks to krunker goes through this instance, routes via ./cached */
export const krunker = new Krunker({
    apiKey: config.krunker_api_token ?? "",
    userAgent: `${meta.getName()}/${meta.getVersion()} (+https://kute.lol)`,
    logger: { debug: (message): void => Log.debug(message), warn: (message): void => Log.warn(message) },
});

if (!krunker.configured) Log.warn("krunker_api_token is not set, every developer api call will fail");
