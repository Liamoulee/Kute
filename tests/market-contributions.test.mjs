import { expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";
import { contributedItem, contributedSale, contributedTrade } from "../src/frontend/modules/market/contributionData.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const rawTrade = { trid: 123, dte: new Date(NOW - 1000).toISOString(), sksell: [{ ind: 1 }], skbuy: [{ ind: 2, cnt: 2 }], csell: [{ cid: 1, amt: 100 }, { cid: 2, amt: 5 }], cbuy: [], player: "must not leave the page", pl: 1234, buy: 4567, buyer: "private", message: "private message" };

test("real completed history preserves both item and currency lists without personal fields", () => {
    const t = contributedTrade(rawTrade, NOW);
    expect(t).toMatchObject({ trid: 123, context: "history", give: [{ skin: 1, count: 1 }], get: [{ skin: 2, count: 2 }], giveKr: 100, getKr: 0, giveCurrencies: [{ id: 1, amount: 100 }, { id: 2, amount: 5 }] });
    for (const privateKey of ["player", "buyer", "pl", "buy", "message"]) expect(t).not.toHaveProperty(privateKey);
    expect(contributedItem({ ind: 1, m: '{"serial":42,"wear":0.2,"paint":3,"owner":"private"}' })).toEqual({ skin: 1, count: 1, serial: 42, wear: 0.2, paint: 3 });
});

test("invalid, cancelled, future and partially parsed trades never become completed facts", () => {
    for (const change of [{ status: "cancelled" }, { dte: new Date(NOW + 1).toISOString() }, { sksell: [{ unknown: 1 }] }, { csell: [{ cid: 1, amt: -3 }] }, { skbuy: [{ ind: 2, count: 0 }] }]){
        expect(contributedTrade({ ...rawTrade, ...change }, NOW)).toBeNull();
    }
    const sale = { marketid: 4, skinindex: 1, amount: 100, type: "sell", date: rawTrade.dte, status: "completed", other_party_name: "private" };
    expect(contributedSale(sale, NOW)).not.toHaveProperty("other_party_name");
    expect(contributedSale({ ...sale, status: "cancelled" }, NOW)).toBeNull();
});

test("game history times are utc in every timezone", () => {
    const zone = process.env.TZ;
    for (const tz of ["Europe/Berlin", "America/New_York", "UTC"]){
        process.env.TZ = tz;
        expect(contributedTrade({ ...rawTrade, dte: "2026-10-19 11:00:00" }, NOW)?.at).toBe(NOW - 3_600_000);
        expect(contributedSale({ marketid: 4, skinindex: 1, amount: 100, type: "sell", status: "completed", date: "2026-10-19 11:00:00" }, NOW)?.date).toBe("2026-10-19T11:00:00.000Z");
    }
    process.env.TZ = zone;
});

const settle = () =>new Promise(resolve => setTimeout(resolve, 10));
const tradeReply = () => ({ data: { completed: [rawTrade], open: [{ ...rawTrade, trid: 999 }], completed_has_more: true } });

function collectorFixture(features = ["history-capture"]){
    let now = NOW;
    class Clock extends Date { static now(){ return now; } }
    const storage = new Map([["krunker_username", "local account"]]); const posted = []; const listeners = [];
    const timers = new Map(); let timerId = 0;
    const context = vm.createContext({ Date: Clock, AbortController, contributedSale, contributedTrade,
        kute: { hostFeatures: features }, document: { hidden: false, pointerLockElement: null },
        window: {
            chrome: { webview: { addEventListener: (name, fn) => listeners.push(fn), removeEventListener: (name, fn) => { const at = listeners.indexOf(fn); if (at >= 0) listeners.splice(at, 1); } } },
            setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
        },
        clearTimeout: id => timers.delete(id), api: { down: false, offline: () => false },
        localStorage: { getItem: k => { if (k.includes("token")) throw new Error("credentials must not be accessed"); return storage.get(k) ?? null; } },
        marketApi: { loggedIn: () => true, retryAt: 0, observe: async(body) => { posted.push(body); return { accepted: 1 }; } },
    });
    const code = fs.readFileSync(new URL("../src/frontend/modules/market/contrib.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export default contrib;", "globalThis.subject = contrib;");
    vm.runInContext(code, context);
    context.subject.start();
    return { subject: context.subject, context, storage, posted, listeners, timers,
        advance: async(ms) => {
            now += ms;
            for (const [id, timer] of [...timers]) if (timer.at <= now){ timers.delete(id); timer.fn(); }
            await settle();
        },
        host: async(reply = tradeReply(), kind = "trades", asObject = false) => {
            const message = { marketHistory: { kind, data: reply } };
            for (const fn of [...listeners]) fn({ data: asObject ? message : JSON.stringify(message) });
            await settle();
        },
    };
}

test("the page never touches fetch or credentials; it only normalizes what the host forwards", async() => {
    const f = collectorFixture();
    expect(f.context.fetch).toBeUndefined();
    expect(f.listeners).toHaveLength(1);
    await f.advance(3_600_000);
    expect(f.posted).toHaveLength(0); expect(f.timers.size).toBe(0);
    await f.host();
    await f.subject.flush();
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0].trades).toHaveLength(1);
    expect(f.posted[0].trades[0]).toMatchObject({ trid: 123, giveKr: 100, get: [{ skin: 2, count: 2 }] });
    expect(JSON.stringify(f.posted)).not.toContain("private");
    expect(JSON.stringify(f.posted)).not.toContain("local account");
    await f.host(); await f.subject.flush();
    expect(f.posted).toHaveLength(1);
});

test("host messages arrive as text or objects; unrelated messages and unknown kinds are ignored", async() => {
    const f = collectorFixture();
    await f.host(tradeReply(), "trades", true);
    expect(f.subject.queue.size).toBe(1);
    for (const data of ["not json", JSON.stringify({ pingInfo: 3 }), JSON.stringify({ marketHistory: { kind: "listings", data: tradeReply() } }), JSON.stringify({ marketHistory: { kind: "trades", data: { error: "nope", data: tradeReply().data } } })]){
        for (const fn of f.listeners) fn({ data });
    }
    await settle();
    expect(f.subject.queue.size).toBe(1);
});

test("an exe without the history capture registers nothing", async() => {
    const f = collectorFixture([]);
    expect(f.listeners).toHaveLength(0);
    expect(f.subject.running).toBe(false);
    f.subject.stop();
    expect(f.listeners).toHaveLength(0);
});

test("stopping detaches the listener and account changes discard pending history", async() => {
    const f = collectorFixture();
    f.subject.stop();
    expect(f.listeners).toHaveLength(0);
    await f.host(); expect(f.subject.queue.size).toBe(0);
    f.subject.start(); expect(f.listeners).toHaveLength(1);
    await f.host(); f.storage.set("krunker_username", "another account"); await f.subject.flush();
    expect(f.posted).toHaveLength(0); expect(f.subject.queue.size).toBe(0);
});

test("gameplay, hidden pages and offline mode drop forwarded history without collecting", async() => {
    const f = collectorFixture();
    f.context.document.pointerLockElement = {}; await f.host();
    f.context.document.pointerLockElement = null; f.context.document.hidden = true; await f.host();
    f.context.document.hidden = false; f.context.api.offline = () => true; await f.host();
    expect(f.subject.queue.size).toBe(0);
});

test("repeated pages deduplicate and shared cooldown pauses uploads", async() => {
    const f = collectorFixture();
    f.context.marketApi.observe = async(body) => { f.posted.push(body); f.context.marketApi.retryAt = NOW + 60_000; return null; };
    await f.host(); await f.subject.flush();
    for (let i = 0; i < 3; i++){ await f.host(); await f.subject.flush(); }
    expect(f.posted).toHaveLength(1); expect(f.subject.queue.size).toBe(1);
    await f.advance(59_999); expect(f.posted).toHaveLength(1);
    f.context.marketApi.observe = async(body) => { f.posted.push(body); return { accepted: 1 }; };
    await f.advance(1);
    expect(f.posted).toHaveLength(2); expect(f.subject.queue.size).toBe(0);
    await f.host(); await f.advance(10_000);
    expect(f.posted).toHaveLength(2);
});

test("failed uploads back off, and stopped uploads cannot clear a restarted queue", async() => {
    const f = collectorFixture(); let release;
    f.context.marketApi.observe = () => new Promise(resolve => { release = resolve; });
    await f.host(); const pending = f.subject.flush();
    f.subject.stop(); f.subject.start(); await f.host();
    release({ accepted: 1 }); await pending;
    expect(f.subject.queue.size).toBe(1);
    f.context.marketApi.observe = async(body) => { f.posted.push(body); return null; };
    await f.advance(10_000); expect(f.posted).toHaveLength(1);
    await f.advance(4999); expect(f.posted).toHaveLength(1);
    await f.advance(1); expect(f.posted).toHaveLength(2);
    await f.advance(9999); expect(f.posted).toHaveLength(2);
});

test("completed market-history responses are normalized without other-party details", async() => {
    const f = collectorFixture();
    await f.host({ data: { history: [
        { marketid: 7, skinindex: 1, amount: 100, type: "sell", status: "completed", date: rawTrade.dte, other_party_name: "private" },
        { marketid: 8, skinindex: 1, amount: 100, type: "sell", status: "cancelled", date: rawTrade.dte },
    ], has_more: true } }, "sales");
    await f.subject.flush();
    expect(f.posted[0].sales).toHaveLength(1); expect(f.posted[0].sales[0]).not.toHaveProperty("other_party_name");
});

test("fractional non-KR currencies and safe transaction identifiers survive normalization", () => {
    const t = contributedTrade({ ...rawTrade, trid: 9_000_000_001, csell: [{ cid: 2, amt: 1.25 }] }, NOW);
    expect(t).toMatchObject({ trid: 9_000_000_001, giveKr: 0, giveCurrencies: [{ id: 2, amount: 1.25 }] });
});
