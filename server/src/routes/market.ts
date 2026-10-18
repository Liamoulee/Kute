import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { krunker } from "../api/index";
import { apiHealth } from "../api/health";
import type { DealsQuery, Grade, HistoryRange, MarketEngine, MoversWindow, ObserveBody, SearchQuery, SearchSort, TradeInput } from "../marketEngine";
import { checkSession, confirmSession, issueChallenge, sessionCounts, type Attestation } from "../util/marketSessions";
import { applyHit, createRateLimit, hit, sourceKey } from "../util/rateLimit";
import { TtlCache } from "../util/ttlCache";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// everything a client reads about the market: derived numbers only, never a krunker reply as is. every
// route but status needs a session (util/marketSessions), has a per session and a per address limit,
// and serves from a short cache so the engine computes each answer once per window

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const SESSION_HEADER = "x-kute-session";
const GRADES: Grade[] = ["A", "B", "C", "D", "F"];
const RANGES: HistoryRange[] = ["1D", "7D", "1M", "3M", "1Y", "ALL"];
const WINDOWS: MoversWindow[] = ["1D", "7D", "30D"];
const SORTS: SearchSort[] = ["volume", "value", "trend1d", "trend7d", "trend30d", "liquidity", "onsale", "name"];
const MAX_VALUE_IDS = 100;
const MAX_TRADE_ITEMS = 40;

const cache = new TtlCache();

type Query = Record<string, string | undefined>;

const int = (value: string | undefined, min: number, max: number): number | undefined => {
    if (value === undefined || value === "") return undefined;
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

const oneOf = <T extends string>(value: string | undefined, allowed: T[]): T | undefined => (allowed.includes(value as T) ? value as T : undefined);

const name = (value: unknown): string | null => (typeof value === "string" && /^[A-Za-z0-9_]{1,20}$/.test(value) ? value : null);

export async function marketRoutes(app: FastifyInstance, options: { engine: MarketEngine | null }): Promise<void> {
    const { engine } = options;
    const statusLimit = createRateLimit("market-status", 30, MINUTE, "Rate limit exceeded. Max 30 requests per minute.");
    const sessionLimit = createRateLimit("market-session", 10, MINUTE, "Rate limit exceeded. Max 10 session requests per minute.");

    // how the collector is doing: job states and row counts, no market data
    app.get("/market/status", { preHandler: statusLimit }, (_req, reply) => {
        reply.header("Cache-Control", "public, max-age=30");
        const window = krunker.rateLimit().global;
        return {
            available: engine !== null,
            ...(engine?.status() ?? { collector: false, jobs: [], counts: {} }),
            key: window ? { limit: window.limit, remaining: window.remaining, resetAt: window.resetAt } : null,
            krunker: apiHealth.snapshot(),
            sessions: sessionCounts(),
        };
    });

    app.post("/market/session", { preHandler: sessionLimit }, (req, reply) => {
        if (!engine) return reply.code(503).send({ error: "market unavailable" });
        return issueChallenge(req.ip);
    });

    app.post("/market/session/confirm", { preHandler: sessionLimit }, (req, reply) => {
        if (!engine) return reply.code(503).send({ error: "market unavailable" });
        const body = (req.body ?? {}) as Partial<Attestation>;
        if (typeof body.challenge !== "string" || typeof body.version !== "string") return reply.code(400).send({ error: "challenge and version are required" });
        const result = confirmSession(req.ip, {
            challenge: body.challenge,
            sig: typeof body.sig === "string" ? body.sig : null,
            version: body.version,
            loggedIn: body.loggedIn === true,
        });
        if (!result.ok) return reply.code(401).send({ error: result.reason });
        return { session: result.session, expiresAt: result.expiresAt };
    });

    /** the gate every data route passes: engine present, session valid, both limits under their max */
    const gate = (req: FastifyRequest, reply: FastifyReply, route: string, perSession: number): string | null => {
        if (!engine){
            reply.code(503).send({ error: "market unavailable" });
            return null;
        }
        const session = checkSession(req.ip, req.headers[SESSION_HEADER] as string | undefined);
        if (!session){
            reply.code(401).send({ error: "session required" });
            return null;
        }
        const key = req.headers[SESSION_HEADER] as string;
        if (!applyHit(reply, hit("market-address", sourceKey(req.ip), 120, MINUTE), "Rate limit exceeded. Max 120 market requests per minute per address.")) return null;
        if (!applyHit(reply, hit("market-" + route, key, perSession, MINUTE), `Rate limit exceeded. Max ${perSession} ${route} requests per minute.`)) return null;
        return key;
    };

    const serve = (reply: FastifyReply, ttlMs: number, key: string, make: () => unknown): unknown => {
        const { value, asOf } = cache.get(key, ttlMs, make);
        reply.header("Cache-Control", `private, max-age=${Math.floor(ttlMs / 1000)}`);
        if (value === null) return reply.code(404).send({ error: "not found" });
        return { asOf, ...(value as object) };
    };

    app.get("/market/intelligence", (req, reply) => {
        if (!gate(req, reply, "read", 60)) return reply;
        if (!engine!.query.intelligence) return reply.code(503).send({ error: "market intelligence unavailable" });
        const q = req.query as Query;
        const skin = int(q.skin, 0, 100_000_000);
        if (q.skin !== undefined && skin === undefined) return reply.code(400).send({ error: "bad skin" });
        const kind = oneOf(q.kind, ["activity", "supply", "relative", "risk", "availability"]);
        return serve(reply, MINUTE, `intelligence:${skin ?? "all"}:${kind ?? "all"}`, () => engine!.query.intelligence!(skin, kind));
    });

    app.get("/market/search", (req, reply) => {
        if (!gate(req, reply, "read", 60)) return reply;
        const q = req.query as Query;
        const query: SearchQuery = {
            q: typeof q.q === "string" ? q.q.slice(0, 40) : undefined,
            rarity: int(q.rarity, 0, 7),
            type: int(q.type, 0, 30),
            season: int(q.season, 1, 50),
            sort: oneOf(q.sort, SORTS),
            page: int(q.page, 1, 200) ?? 1,
            budget: int(q.budget, 1, 1_000_000_000),
            minSales: int(q.min_sales, 0, 100_000),
        };
        return serve(reply, MINUTE, "search:" + JSON.stringify(query), () => engine!.query.search(query));
    });

    app.get("/market/item/:id", async(req, reply) => {
        if (!gate(req, reply, "read", 60)) return reply;
        const id = int((req.params as { id: string }).id, 0, 100_000_000);
        if (id === undefined) return reply.code(400).send({ error: "bad skin" });
        const { value } = await cache.getAsync(`item:${id}`, 5 * MINUTE, () => engine!.query.item(id));
        if (!value) return reply.code(404).send({ error: "not found" });
        reply.header("Cache-Control", "private, max-age=300");
        return value;
    });

    app.get("/market/item/:id/desk", async(req, reply) => {
        if (!gate(req, reply, "read", 60)) return reply;
        const id = int((req.params as { id: string }).id, 0, 100_000_000);
        const range = oneOf((req.query as Query).range, RANGES) ?? "1M";
        if (id === undefined) return reply.code(400).send({ error: "bad skin" });
        const { value: item } = await cache.getAsync(`item:${id}`, 5 * MINUTE, () => engine!.query.item(id));
        if (!item) return reply.code(404).send({ error: "not found" });
        const { value: history } = cache.get(`history:${id}:${range}`, 5 * MINUTE, () => engine!.query.history(id, range));
        const { value: listings } = cache.get(`listings:${id}`, MINUTE, () => engine!.query.listings(id));
        reply.header("Cache-Control", "private, max-age=60");
        return { item, history, listings };
    });

    app.get("/market/item/:id/history", (req, reply) => {
        if (!gate(req, reply, "read", 60)) return reply;
        const id = int((req.params as { id: string }).id, 0, 100_000_000);
        const range = oneOf((req.query as Query).range, RANGES) ?? "1M";
        if (id === undefined) return reply.code(400).send({ error: "bad skin" });
        return serve(reply, 5 * MINUTE, `history:${id}:${range}`, () => engine!.query.history(id, range));
    });

    app.get("/market/item/:id/listings", (req, reply) => {
        if (!gate(req, reply, "read", 60)) return reply;
        const id = int((req.params as { id: string }).id, 0, 100_000_000);
        if (id === undefined) return reply.code(400).send({ error: "bad skin" });
        return serve(reply, MINUTE, `listings:${id}`, () => engine!.query.listings(id));
    });

    // ids are skin indices; thumbs are preview image paths (the part after textures/previews/), which is all a market card shows
    app.get("/market/value", (req, reply) => {
        if (!gate(req, reply, "read", 60)) return reply;
        const q = req.query as Query;
        if (q.thumbs !== undefined){
            const paths = [...new Set(q.thumbs.split(",").filter((p) => /^[a-z0-9_/.-]{1,80}$/i.test(p)))].sort();
            if (!paths.length || paths.length > MAX_VALUE_IDS) return reply.code(400).send({ error: `thumbs: 1 to ${MAX_VALUE_IDS} preview paths` });
            return serve(reply, 5 * MINUTE, "thumbs:" + paths.join(","), () => engine!.query.valueByThumbnails(paths));
        }
        const raw = (q.ids ?? "").split(",").filter(Boolean);
        const ids = [...new Set(raw.map((v) => int(v, 0, 100_000_000)).filter((v): v is number => v !== undefined))].sort((a, b) => a - b);
        if (!ids.length || ids.length > MAX_VALUE_IDS) return reply.code(400).send({ error: `ids: 1 to ${MAX_VALUE_IDS} skin indices` });
        return serve(reply, 5 * MINUTE, "value:" + ids.join(","), () => engine!.query.value(ids));
    });

    app.get("/market/movers", (req, reply) => {
        if (!gate(req, reply, "read", 60)) return reply;
        const window = oneOf((req.query as Query).window, WINDOWS) ?? "7D";
        return serve(reply, 5 * MINUTE, "movers:" + window, () => engine!.query.movers(window));
    });

    app.get("/market/deals", (req, reply) => {
        if (!gate(req, reply, "read", 60)) return reply;
        const q = req.query as Query;
        const query: DealsQuery = { budget: int(q.budget, 1, 1_000_000_000), minGrade: oneOf(q.min_grade, GRADES), rarity: int(q.rarity, 0, 7), type: int(q.type, 0, 30), limit: int(q.limit, 1, 200) ?? 50 };
        return serve(reply, MINUTE, "deals:" + JSON.stringify(query), () => engine!.query.deals(query));
    });

    app.get("/market/indices", (req, reply) => {
        if (!gate(req, reply, "read", 60)) return reply;
        return serve(reply, 60 * MINUTE, "indices", () => engine!.query.indices());
    });

    app.get("/market/overview", (req, reply) => {
        if (!gate(req, reply, "read", 60)) return reply;
        return serve(reply, 60 * MINUTE, "overview", () => engine!.query.overview());
    });

    app.post("/market/analyze", (req, reply) => {
        if (!gate(req, reply, "analyze", 20)) return reply;
        const body = (req.body ?? {}) as Partial<TradeInput>;
        const side = (items: unknown): TradeInput["give"] | null => {
            if (!Array.isArray(items) || items.length > MAX_TRADE_ITEMS) return null;
            const out: TradeInput["give"] = [];
            for (const item of items as Record<string, unknown>[]){
                const skin = int(String(item.skin), 0, 100_000_000);
                const count = int(String(item.count ?? 1), 1, 10_000);
                if (skin === undefined || count === undefined) return null;
                out.push({
                    skin,
                    count,
                    serial: typeof item.serial === "number" && item.serial > 0 ? Math.floor(item.serial) : undefined,
                    wear: typeof item.wear === "number" && item.wear >= 0 && item.wear <= 1 ? item.wear : undefined,
                    style: typeof item.style === "number" ? Math.floor(item.style) : undefined,
                });
            }
            return out;
        };
        const give = side(body.give ?? []);
        const get = side(body.get ?? []);
        const kr = (v: unknown): number | null => {
            if (v === undefined) return 0;
            return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9 ? Math.floor(v) : null;
        };
        const giveKr = kr(body.giveKr);
        const getKr = kr(body.getKr);
        if (!give || !get || giveKr === null || getKr === null) return reply.code(400).send({ error: "give and get are item lists of {skin, count}, giveKr and getKr numbers" });
        if (!give.length && !get.length && !giveKr && !getKr) return reply.code(400).send({ error: "an empty trade" });
        return engine!.query.analyze({ give, get, giveKr, getKr });
    });

    app.get("/market/portfolio", async(req, reply) => {
        if (!gate(req, reply, "portfolio", 6)) return reply;
        const player = name((req.query as Query).name);
        if (!player) return reply.code(400).send({ error: "name: a krunker username" });
        const { value } = await cache.getAsync("portfolio:" + player.toLowerCase(), 5 * MINUTE, () => engine!.query.portfolio(player));
        if (!value) return reply.code(404).send({ error: "player not found" });
        reply.header("Cache-Control", "private, max-age=300");
        return value;
    });

    app.post("/market/observe", { bodyLimit: 256 * 1024 }, (req, reply) => {
        const session = gate(req, reply, "observe", 10);
        if (!session) return reply;
        const body = req.body as ObserveBody | null;
        if (!body || typeof body !== "object") return reply.code(400).send({ error: "a json body" });
        const rejected = [body.listings, body.sales, body.trades].reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
        return { accepted: 0, rejected };
    });
}
