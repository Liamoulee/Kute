import { expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

function source(path, name){
    return fs.readFileSync(new URL(path, import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(`export default ${name};`, `globalThis.subject = ${name};`);
}

test("HTTP failures trip the circuit breaker; rate limits do not reset its failure count", async() => {
    const responses = [503, 429, 502, 500];
    const calls = [];
    const context = vm.createContext({ kute: { settings: { data: {} } }, ready: Promise.resolve(), AbortSignal, Date,
        fetch: async(url) => {
            calls.push(url);
            return new Response(JSON.stringify(url.endsWith("/health") ? { ok: true } : {}), { status: url.endsWith("/health") ? 200 : responses.shift() });
        },
    });
    vm.runInContext(source("../src/frontend/modules/api.js", "api"), context);
    for (let i = 0; i < 5; i++) await context.subject.requestStatus("/market/analyze");
    expect(calls).toHaveLength(5);
    expect(context.subject.down).toBe(true);
});

test("a proxy 429 without deadline headers waits a full minute", async() => {
    const context = vm.createContext({ kute: { settings: { data: {} } }, ready: Promise.resolve(), AbortSignal, Date,
        fetch: async(url) => url.endsWith("/health") ? new Response('{"ok":true}') : new Response("{}", { status: 429 }),
    });
    vm.runInContext(source("../src/frontend/modules/api.js", "api"), context);
    const before = Date.now();
    const result = await context.subject.requestStatus("/market/analyze");
    expect(result.retryAt).toBeGreaterThanOrEqual(before + 60_000);
});

test("429 exposes the later server deadline from headers and JSON", async() => {
    const resetAt = Date.now() + 75_000;
    const context = vm.createContext({ kute: { settings: { data: {} } }, ready: Promise.resolve(), AbortSignal, Date,
        fetch: async(url) => url.endsWith("/health") ? new Response('{"ok":true}') : new Response(JSON.stringify({ resetAt }), { status: 429, headers: { "Retry-After": "30", "X-RateLimit-Reset": String(Math.floor((resetAt - 1000) / 1000)) } }),
    });
    vm.runInContext(source("../src/frontend/modules/api.js", "api"), context);
    const result = await context.subject.requestStatus("/market/analyze");
    expect(result.retryAt).toBe(resetAt);
});

function marketFixture(responses){
    let now = 1_000_000;
    class Clock extends Date { static now(){ return now; } }
    const calls = [];
    const context = vm.createContext({ Date: Clock, kute: {}, localStorage: { getItem: () => null }, api: {
        requestStatus: async(path) => { calls.push(path); return responses.shift() ?? { status: 200, data: {} }; },
        retry: async() => true,
    } });
    vm.runInContext(source("../src/frontend/modules/market/api.js", "marketApi"), context);
    context.subject.memorySession = { session: "fixture", expiresAt: now + 86_400_000 };
    return { api: context.subject, calls, advance: (ms) => { now += ms; } };
}

test("market cooldown blocks searches, analysis and manual retries while cached reads still work", async() => {
    const f = marketFixture([{ status: 200, data: { item: 1 } }, { status: 429, data: null, retryAt: 1_060_000 }]);
    await f.api.cached("/market/value?ids=1", 300_000);
    await f.api.analyzeStatus({ give: [], get: [], giveKr: 1, getKr: 0 });
    for (let i = 0; i < 50; i++) await f.api.request("/market/search?q=" + i);
    expect(await f.api.retry()).toBe(false);
    expect(await f.api.cached("/market/value?ids=1", 300_000)).toEqual({ item: 1 });
    expect(f.calls).toHaveLength(2);
    expect(f.api.lastError).toContain("limit reached");
    f.advance(60_000);
    await f.api.request("/market/search?q=ready");
    expect(f.calls).toHaveLength(3);
});

test("item desk is one cached request with a fallback for older servers only", async() => {
    const desk = { item: { skin: 1 }, history: { points: [] }, listings: { listings: [] } };
    const current = marketFixture([{ status: 200, data: desk }]);
    expect(await current.api.itemDesk(1, "1M")).toEqual(desk);
    await current.api.itemDesk(1, "1M");
    expect(current.calls).toHaveLength(1);
    const old = marketFixture([{ status: 404, data: null }, ...Object.values(desk).map((data) => ({ status: 200, data }))]);
    expect(await old.api.itemDesk(1, "1M")).toEqual(desk);
    expect(old.calls).toHaveLength(4);
    const busy = marketFixture([{ status: 429, data: null, retryAt: 1_060_000 }]);
    expect(await busy.api.itemDesk(1, "1M")).toBeNull();
    expect(busy.calls).toHaveLength(1);
});
