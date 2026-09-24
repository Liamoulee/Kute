import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import helmet from "@fastify/helmet";
import { createRateLimit } from "./util/rateLimit";
import { initDb } from "./db";
import { loadPlayerStats } from "./util/playerStats";
import { metaRoutes } from "./routes/meta";
import { presenceRoutes } from "./routes/presence";
import { config, meta } from "../config/config";
import sheduleCrons from "./util/cron";
import { envName, envWasSet, isDevelopment } from "./util/env";
import Log from "./util/log";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

const appname = meta.getName();
const version = meta.getVersion();
const author = meta.getAuthor();
const pad = 16 + appname.length + version.toString().length + author.length;

Log.raw(
    "\n" +
    " #" + "-".repeat(pad) + "#\n" +
    " # Started " + appname + " v" + version + " by " + author + " #\n" +
    " #" + "-".repeat(pad) + "#\n",
);

Log.info("--- START ---");
Log.info(appname + " v" + version + " by " + author);

Log.info("Environment: " + envName);
if (!envWasSet) Log.warn("NODE_ENV is not set to 'development' or 'production', running as production. Use 'bun run start:dev' or 'bun run start:prod'.");
Log.debug("Bun version: " + Bun.version, true);
Log.debug("OS: " + process.platform + " " + process.arch, true);

Log.wait("Ensuring data dir...");
if (!fs.existsSync(path.resolve("./data"))){
    const dataDir = path.resolve("./data");
    fs.mkdirSync(dataDir);
    fs.closeSync(fs.openSync(path.resolve(dataDir, ".gitkeep"), "w"));
    Log.done("Created missing data dir!");
}
else Log.done("Data dir exists!");

const app = Fastify({
    logger: {
        level: isDevelopment ? "debug" : "info",
        serializers: {
            req: (req) => ({ method: req.method, url: req.url }),
        },
    },
    trustProxy: true,
});

initDb();
loadPlayerStats();
sheduleCrons();

app.register(cors, { origin: "*" });
// public/kr gets embedded by krunker.io, helmet's default same-origin CORP would block it
app.register(helmet, { crossOriginResourcePolicy: { policy: "cross-origin" } });
app.register(websocket);

// api only, one website visit alone loads 10+ files
const globalLimit = createRateLimit("global", 10, 1000, "Rate limit exceeded. Max 10 requests per second.");
app.addHook("onRequest", async(req, reply) => {
    if (req.url.startsWith("/api")) await globalLimit(req, reply);
    return reply.sent ? reply : undefined;
});

app.register(fastifyStatic, {
    root: path.join(import.meta.dir, "../public"),
    prefix: "/",
});

app.register(metaRoutes, { prefix: "/api" });
app.register(presenceRoutes, { prefix: "/api" });

const port = parseInt(config.server.port ?? "3030", 10);
await app.listen({ port, host: "127.0.0.1" });

process.on("unhandledRejection", (err: Error) => Log.error("Unhandled promise rejection: ", err));
