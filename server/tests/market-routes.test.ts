import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { marketRoutes } from "../src/routes/market";
import { confirmSession, issueChallenge, keyForVersion } from "../src/util/marketSessions";
import type { MarketEngine } from "../src/marketEngine";

test("an item desk consumes one read, reuses caches and contributions reach the validator", async() => {
    const calls = { item: 0, history: 0, listings: 0, observe: 0 };
    const engine = { query: {
        item: async() => { calls.item++; return { asOf: 123, skin: { skin: 987654 } }; },
        history: () => { calls.history++; return { points: [] }; },
        listings: () => { calls.listings++; return { listings: [] }; },
        observe: () => { calls.observe++; return { accepted: 2, rejected: 1 }; },
    } } as unknown as MarketEngine;
    const app = Fastify();
    await app.register(marketRoutes, { engine });
    const ip = "127.0.0.98";
    const { challenge } = issueChallenge(ip);
    const version = "9999.0.0";
    const key = keyForVersion(version);
    const sig = key ? createHmac("sha256", key).update(`${challenge}|${version}|1`).digest("base64") : null;
    const session = confirmSession(ip, { challenge, version, sig, loggedIn: true });
    if (!session.ok) throw new Error("fixture session refused");
    const headers = { "x-kute-session": session.session };
    try {
        const anonymous = await app.inject({ url: "/market/item/987654/desk", remoteAddress: ip });
        expect(anonymous.statusCode).toBe(401);
        const result = await app.inject({ url: "/market/item/987654/desk?range=1M", headers, remoteAddress: ip });
        expect(result.statusCode).toBe(200);
        expect(result.json()).toEqual({ item: { asOf: 123, skin: { skin: 987654 } }, history: { points: [] }, listings: { listings: [] } });
        expect(Number(result.headers["x-ratelimit-limit"]) - Number(result.headers["x-ratelimit-remaining"])).toBe(1);
        await app.inject({ url: "/market/item/987654/desk?range=1M", headers, remoteAddress: ip });
        await app.inject({ url: "/market/item/987654", headers, remoteAddress: ip });
        expect(calls).toEqual({ item: 1, history: 1, listings: 1, observe: 0 });
        const observed = await app.inject({ method: "POST", url: "/market/observe", headers, remoteAddress: ip, payload: { sales: [{ marketid: 1 }], trades: [{ trid: 1 }], listings: [{ uid: 1 }] } });
        expect(observed.json()).toEqual({ accepted: 2, rejected: 1 });
        expect(calls.observe).toBe(1);
    }
    finally { await app.close(); }
});
