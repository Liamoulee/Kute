import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { createRateLimit } from "./util/rateLimit";
import { initDb } from "./db";
import { metaRoutes } from "./routes/meta";
import { telemetryRoutes } from "./routes/telemetry";
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
        // the default request log carries the caller's address. nothing this server writes down may
        serializers: {
            req: (req) => ({ method: req.method, url: req.url }),
        },
    },
    // behind nginx: the address for the rate limit comes from X-Forwarded-For
    trustProxy: true,
});

initDb();
sheduleCrons();

app.register(cors, { origin: "*" });
app.register(helmet);

app.addHook("onRequest", createRateLimit("global", 10, 1000, "Rate limit exceeded. Max 10 requests per second."));

app.register(metaRoutes, { prefix: "/api" });
app.register(telemetryRoutes, { prefix: "/api/telemetry" });

const port = parseInt(config.server.port ?? "3030", 10);
await app.listen({ port, host: "127.0.0.1" });

process.on("unhandledRejection", (err: Error) => Log.error("Unhandled promise rejection: ", err));
