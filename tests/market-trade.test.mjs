import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";
import { esc, TRADE_VERDICTS } from "../src/frontend/modules/market/presentation.js";
import { GRADE_COLORS, formatKr, formatPercent } from "../src/frontend/modules/market/types.js";

const source = fs.readFileSync(new URL("../src/frontend/modules/market/trade.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace("export default trade;", "globalThis.trade = trade;");

function fixture(){
    const requests = []; const lookups = [];
    const panel = { innerHTML: "", querySelector: () => null };
    const box = { style: {}, isConnected: false, nextElementSibling: null, shadowRoot: { querySelector: () => panel }, attachShadow(){ return this.shadowRoot; }, remove(){ this.isConnected = false; } };
    const anchor = { before(el){ el.nextElementSibling = this; el.isConnected = true; }, contains: () => true };
    const offers = [[], []];
    const sides = offers.map((items) => ({ parentElement: anchor, getClientRects: () => [{}], querySelectorAll: (selector) => selector === ".trade-offer-scroll .trade-inv-item" ? items : [] }));
    const document = { body: {}, hidden: false, pointerLockElement: null, querySelectorAll: () => sides, getElementById: () => null, createElement: () => box };
    const context = vm.createContext({ document, window: { setInterval: () => 1, addEventListener(){}, removeEventListener(){} }, clearInterval(){}, HTMLInputElement: class {}, esc, TRADE_VERDICTS, GRADE_COLORS, formatKr, formatPercent, template: "",
        marketApi: { analyze: (input) => new Promise((resolve) => requests.push({ input, resolve })), valuesByThumbnails: async(paths) => { lookups.push(paths); return {}; } },
    });
    vm.runInContext(source, context);
    context.trade.start();
    const add = (side, skin, count = 1, extra = {}) => {
        const attributes = { "data-index": String(skin), ...extra };
        const item = { count, getAttribute: (key) => attributes[key] ?? null, querySelector: (selector) => selector === ".trade-item-count" ? { textContent: `x${item.count}` } : { getAttribute: () => "https://assets.krunker.io/textures/paints/paint_black.webp" } };
        offers[side].push(item);
        return item;
    };
    return { trade: context.trade, context, document, requests, lookups, box, panel, anchor, sides, offers, add };
}

const side = (items = []) => ({ items, value: 100, kr: 0, confidence: 20 });
const verdict = (items = []) => ({ verdict: "uncertain", difference: 0, differenceShare: 0, give: side(items), get: side(), drivers: ["<img src=x onerror=alert(1)>"] });

describe("native trade analysis", () => {
    test("legacy offers keep quantities and added KR without reading inventory entries", () => {
        const f = fixture(); f.sides.length = 0;
        const item = (id, count) => ({ id, querySelector: () => ({ textContent: `x${count}` }) });
        const lists = [
            { parentElement: f.anchor, getClientRects: () => [{}], querySelectorAll: () => [item("trd_0_12", 3), item("trd_inv_0_99", 5)] },
            { parentElement: f.anchor, getClientRects: () => [{}], querySelectorAll: () => [item("trd_1_32_1234", 1)] },
        ];
        f.document.getElementById = (id) => ({ tradeList0: lists[0], tradeList1: lists[1], offerVal0: { textContent: "1,500 KR" }, offerVal1: { textContent: "0" } })[id];
        const snapshot = f.trade.snapshot();
        expect(snapshot.give).toEqual([{ skin: 12, count: 3 }]);
        expect(snapshot.get).toEqual([{ skin: 32, count: 1 }]);
        expect(snapshot.giveKr).toBe(1500);
        expect(snapshot.anchor).toBe(f.anchor);
    });

    test("thumbnail fallback retains the full stack when markup has no item ID", async() => {
        const f = fixture();
        const item = f.add(0, "invalid", 4);
        const original = item.querySelector;
        item.querySelector = (selector) => selector === "img" ? { getAttribute: () => "https://assets.krunker.io/textures/previews/weapons/test.png?v=1" } : original(selector);
        f.context.marketApi.valuesByThumbnails = async() => ({ "weapons/test.png": { skin: 123 } });
        f.context.marketApi.analyze = async(input) => { f.requests.push({ input }); return verdict(); };
        await f.trade.tick();
        expect(f.requests[0].input.give).toEqual([{ skin: 123, count: 4 }]);
    });

    test("hidden pages and gameplay never start analysis requests", async() => {
        const f = fixture(); f.add(0, 7018);
        f.document.hidden = true; await f.trade.tick();
        f.document.hidden = false; f.document.pointerLockElement = {}; await f.trade.tick();
        f.document.pointerLockElement = null; f.trade.stop(); await f.trade.tick();
        expect(f.requests).toHaveLength(0);
    });

    test("reads offered paints, quantities and instance attributes without counting inventory or estimated KR", async() => {
        const f = fixture();
        f.add(0, 7779, 2);
        f.add(1, 7886, 1, { "data-serial": "45", "data-wear-float": "0.9533" });
        const work = f.trade.tick();
        expect(f.requests[0].input).toEqual({ give: [{ skin: 7779, count: 2 }], get: [{ skin: 7886, count: 1, serial: 45, wear: 0.9533 }], giveKr: 0, getKr: 0 });
        expect(f.lookups).toHaveLength(0);
        f.requests[0].resolve(verdict()); await work;
        expect(f.box.nextElementSibling).toBe(f.anchor);
    });

    test("quantity changes invalidate a pending result and trigger a fresh comparison", async() => {
        const f = fixture(); const item = f.add(0, 7779);
        const work = f.trade.tick();
        item.count = 2;
        f.requests[0].resolve(verdict()); await work;
        expect(f.panel.innerHTML).toContain("Updating estimates");
        const next = f.trade.tick();
        expect(f.requests[1].input.give[0].count).toBe(2);
        f.requests[1].resolve(verdict()); await next;
    });

    test("late results cannot resurrect a stopped, replaced or closed trade", async() => {
        for (const action of ["stop", "close", "replace", "gameplay"]){
            const f = fixture(); f.add(0, 7018);
            const work = f.trade.tick();
            if (action === "stop") f.trade.stop();
            if (action === "close") f.sides.length = 0;
            if (action === "replace") f.sides.forEach((s) => { s.parentElement = { contains: () => true }; });
            if (action === "gameplay") f.document.pointerLockElement = {};
            f.requests[0].resolve(verdict()); await work;
            expect(f.panel.innerHTML).not.toContain("Item breakdown");
            if (action === "stop") expect(f.box.isConnected).toBe(false);
        }
    });

    test("unidentified items never disappear into a misleading total", async() => {
        const f = fixture(); f.add(0, "invalid");
        await f.trade.tick();
        expect(f.requests).toHaveLength(0);
        expect(f.panel.innerHTML).toContain("could not be identified");
    });

    test("failed estimates retry without changing the offer", async() => {
        const f = fixture(); f.add(0, 7018);
        const first = f.trade.tick(); f.requests[0].resolve(null); await first;
        expect(f.panel.innerHTML).toContain("Estimates unavailable");
        const retry = f.trade.tick();
        expect(f.requests).toHaveLength(2);
        f.requests[1].resolve(verdict()); await retry;
    });

    test("one-sided drafts suppress the percentage verdict and escape server text", async() => {
        const f = fixture(); f.add(0, 7018);
        const work = f.trade.tick();
        f.requests[0].resolve(verdict([{ name: "<b>Arctaurus</b>", count: 1, grade: "F", lineValue: 100 }])); await work;
        expect(f.panel.innerHTML).toContain("Add items on both sides");
        expect(f.panel.innerHTML).toContain("Incomplete comparison");
        expect(f.panel.innerHTML).toContain("&lt;b&gt;Arctaurus&lt;/b&gt;");
        expect(f.panel.innerHTML).not.toContain("<img");
        expect(f.panel.innerHTML).not.toContain("<details open");
    });

    test("unknown values mark totals as partial and suppress the difference", async() => {
        const f = fixture(); f.add(0, 7018); f.add(1, 99999);
        const work = f.trade.tick();
        f.requests[0].resolve(verdict([{ name: "Unknown", count: 1, unknown: true }])); await work;
        expect(f.panel.innerHTML).toContain("Partial estimate");
        expect(f.panel.innerHTML).toContain("Unvalued");
        expect(f.panel.innerHTML).toContain("Incomplete comparison");
    });
});
