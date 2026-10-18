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

function collectorFixture(){
    let now = NOW;
    class Clock extends Date { static now(){ return now; } }
    const storage = new Map([["__FRVR_auth_access_token", JSON.stringify("fixture token")]]); const posted = []; const requested = [];
    const context = vm.createContext({ Date: Clock, AbortController, AbortSignal, contributedSale, contributedTrade,
        document: { hidden: false, pointerLockElement: null }, window: { setTimeout: () => 1 }, clearTimeout: () => {},
        api: { down: false, offline: () => false },
        localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
        marketApi: { loggedIn: () => true, retryAt: 0, observe: async(body) => { posted.push(body); return { accepted: 1 }; } },
        fetch: async(url, init) => {
            requested.push({ url, auth: init.headers.Authorization });
            return { ok: true, json: async() => ({ data: url.includes("/trades/") ? { completed: [rawTrade], open: [{ ...rawTrade, trid: 999 }], completed_has_more: false } : { history: [], has_more: false } }) };
        },
    });
    const code = fs.readFileSync(new URL("../src/frontend/modules/market/contrib.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export default contrib;", "globalThis.subject = contrib;");
    vm.runInContext(code, context);
    context.subject.start();
    return { subject: context.subject, context, storage, posted, requested, advance: ms => { now += ms; } };
}

test("collector uses decoded local credentials, reads completed rather than open and remembers successful sources", async() => {
    const f = collectorFixture();
    await f.subject.tick(); await f.subject.tick();
    expect(f.requested).toHaveLength(2);
    expect(f.requested[1].auth).toBe("Bearer fixture token");
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0].trades[0].trid).toBe(123);
    expect(JSON.stringify(f.posted)).not.toContain("fixture token");
    expect(JSON.stringify(f.posted)).not.toContain("private");
});

test("stopping during a history read prevents submission and does not mark it complete", async() => {
    const f = collectorFixture();
    let release;
    f.subject.read = () => new Promise(resolve => { release = resolve; });
    const pending = f.subject.tick();
    f.subject.stop(); release({ history: [], has_more: false }); await pending;
    expect(f.posted).toHaveLength(0);
    expect(f.storage.has("kute_market_contribution_checks")).toBe(false);
});

test("gameplay, hidden pages, offline mode and cooldown pause contribution reads", async() => {
    const f = collectorFixture();
    f.context.document.pointerLockElement = {}; await f.subject.tick();
    f.context.document.pointerLockElement = null; f.context.document.hidden = true; await f.subject.tick();
    f.context.document.hidden = false; f.context.marketApi.retryAt = NOW + 1000; await f.subject.tick();
    f.context.marketApi.retryAt = 0; f.context.api.offline = () => true; await f.subject.tick();
    expect(f.requested).toHaveLength(0);
});

test("failed history reads remain due and a successful other source is not repeated", async() => {
    const f = collectorFixture(); const read = f.subject.read.bind(f.subject);
    f.subject.read = path => path.includes("/market/") ? Promise.reject(new Error("unavailable")) : read(path, "fixture token", new AbortController().signal);
    await f.subject.tick();
    expect(JSON.parse(f.storage.get("kute_market_contribution_checks"))).toEqual({ trades: NOW });
    f.subject.read = read; await f.subject.tick();
    expect(f.posted).toHaveLength(1);
    expect(JSON.parse(f.storage.get("kute_market_contribution_checks"))).toEqual({ trades: NOW, sales: NOW });
});

test("a failed submission stays due and the shared 429 deadline prevents repeat reads or posts", async() => {
    const f = collectorFixture();
    f.context.marketApi.observe = async() => { f.context.marketApi.retryAt = NOW + 60_000; return null; };
    await f.subject.tick();
    expect(JSON.parse(f.storage.get("kute_market_contribution_checks"))).toEqual({ sales: NOW });
    for (let i = 0; i < 10; i++) await f.subject.tick();
    expect(f.requested).toHaveLength(2);
    f.advance(60_000); f.context.marketApi.observe = async() => ({ accepted: 1 });
    await f.subject.tick();
    expect(f.requested).toHaveLength(3);
    expect(JSON.parse(f.storage.get("kute_market_contribution_checks")).trades).toBe(NOW + 60_000);
});

test("fractional non-KR currencies and safe transaction identifiers survive normalization", () => {
    const t = contributedTrade({ ...rawTrade, trid: 9_000_000_001, csell: [{ cid: 2, amt: 1.25 }] }, NOW);
    expect(t).toMatchObject({ trid: 9_000_000_001, giveKr: 0, giveCurrencies: [{ id: 2, amount: 1.25 }] });
});

test("a cooldown from the first source also stops the second source in the same run", async() => {
    const f = collectorFixture(); const reads = [];
    f.subject.read = async(path) => {
        reads.push(path);
        return { history: [{ marketid: 7, skinindex: 1, amount: 100, type: "sell", status: "completed", date: rawTrade.dte }], has_more: false };
    };
    f.context.marketApi.observe = async() => { f.context.marketApi.retryAt = NOW + 60_000; return null; };
    await f.subject.tick();
    expect(reads).toHaveLength(1);
    expect(f.storage.has("kute_market_contribution_checks")).toBe(false);
});
