import type { FastifyInstance } from "fastify";
import { getDb } from "../db";
import { createRateLimit } from "../util/rateLimit";
import { parseFailure, parseReport } from "../util/report";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

// the day is all the time that is kept
const today = (): string => new Date().toISOString().slice(0, 10);

export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
    const insertReport = getDb().prepare(
        `INSERT INTO autodetect_reports
            (received_day, kute_version, run_index, gpu, cpu, hz, laptop, base_fps, final_fps, regime, holds_goal, changes,
             renderer, os_build, ram_gb, threads, canvas_width, canvas_height, resolution, hard_flip, throttle, fps_limit,
             present_p99, report)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFailure = getDb().prepare(
        "INSERT INTO autodetect_failures (received_day, kute_version, stage, message, seconds) VALUES (?, ?, ?, ?, ?)",
    );

    // A run takes a minute, so a handful per hour is already generous. One limiter for both routes.
    const limit = createRateLimit("autodetect", 6, 60 * 60 * 1000, "Rate limit exceeded. Max 6 reports per hour.");

    // The result of one auto-detect run, sent by clients that did not opt out. The columns are what gets
    // filtered and grouped by, everything else (every single measurement) is in the report JSON next to them.
    app.post("/autodetect", { bodyLimit: 64 * 1024, onRequest: limit }, (req, reply) => {
        const report = parseReport(req.body);
        if (typeof report === "string"){
            return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: report });
        }

        const { details } = report;
        const setting = (key: string): string | number | boolean | null => details?.clientSettings[key] ?? null;
        insertReport.run(
            today(),
            report.kute,
            report.run,
            report.gpu,
            report.cpu,
            report.hz,
            report.laptop ? 1 : 0,
            report.baseFps,
            report.finalFps,
            report.plan.regime,
            report.plan.holds ? 1 : 0,
            report.plan.changes.length,
            details?.system.renderer ?? null,
            details?.system.osBuild ?? null,
            details?.system.ramGb ?? null,
            details?.system.threads ?? null,
            details?.system.canvas[0] ?? null,
            details?.system.canvas[1] ?? null,
            details?.game.resolution ?? null,
            setting("hardFlip") === null ? null : Number(setting("hardFlip")),
            typeof setting("throttle") === "number" ? setting("throttle") : null,
            typeof setting("gameFpsLimit") === "number" ? setting("gameFpsLimit") : null,
            details?.baseline.present?.p99 ?? null,
            JSON.stringify(report),
        );
        return reply.code(204).send();
    });

    // A run that stopped before it had a result. This is how a changed Krunker host window gets noticed.
    app.post("/autodetect-failure", { bodyLimit: 4 * 1024, onRequest: limit }, (req, reply) => {
        const failure = parseFailure(req.body);
        if (typeof failure === "string"){
            return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: failure });
        }
        insertFailure.run(today(), failure.kute, failure.stage, failure.message, failure.seconds);
        return reply.code(204).send();
    });
}
