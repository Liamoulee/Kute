import { Krunker } from "krapio";
import { config, meta } from "../../config/config";
import { apiHealth } from "./health";
import Log from "../util/log";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export * from "krapio";

/** the proxy url from the config, checked once: bun's fetch only tunnels through http(s) proxies, a socks url fails on every request */
function proxyUrl(): string | undefined {
    const url = config.krunker_api_proxy?.trim();
    if (!url) return undefined;
    const scheme = new URL(url).protocol;
    if (scheme !== "http:" && scheme !== "https:") throw new Error(`krunker_api_proxy "${url}": bun's fetch supports http and https proxies only (cloudflare warp answers http on its socks port)`);
    Log.info("Krunker API requests go through the proxy at " + new URL(url).host + ".");
    return url;
}

const proxy = proxyUrl();

/** one api key, one rate limit window: everything that talks to krunker goes through this instance, routes via ./cached */
export const krunker = new Krunker({
    apiKey: config.krunker_api_token ?? "",
    userAgent: `${meta.getName()}/${meta.getVersion()} (+https://kute.lol)`,
    logger: { debug: (message): void => Log.debug(message), warn: (message): void => Log.warn(message) },
    // every reply passes the health watch, which alerts the owner when krunker stops answering us
    fetch: apiHealth.wrap((input, init) => fetch(input, proxy ? { ...init, proxy } : init)),
});

if (!krunker.configured) Log.warn("krunker_api_token is not set, every developer api call will fail");
