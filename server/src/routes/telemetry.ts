import type { FastifyInstance } from "fastify";
import { getDb } from "../db";
import { createRateLimit } from "../util/rateLimit";
import { parseReport } from "../util/report";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
    const insert = getDb().prepare(
        `INSERT INTO autodetect_reports
            (received_day, kute_version, gpu, cpu, hz, laptop, base_fps, final_fps, regime, holds_goal, changes, report)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // The result of one auto-detect run, sent by clients that did not opt out. A run takes a minute,
    // so a handful per hour is already generous.
    app.post("/autodetect", {
        bodyLimit: 32 * 1024,
        onRequest: createRateLimit("autodetect", 6, 60 * 60 * 1000, "Rate limit exceeded. Max 6 reports per hour."),
    }, (req, reply) => {
        const report = parseReport(req.body);
        if (typeof report === "string"){
            return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: report });
        }

        insert.run(
            // the day is all the time that is kept
            new Date().toISOString().slice(0, 10),
            report.kute,
            report.gpu,
            report.cpu,
            report.hz,
            report.laptop ? 1 : 0,
            report.baseFps,
            report.finalFps,
            report.plan.regime,
            report.plan.holds ? 1 : 0,
            report.plan.changes.length,
            JSON.stringify(report),
        );
        return reply.code(204).send();
    });
}
