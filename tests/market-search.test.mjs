import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/frontend/modules/market/itemSearch.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace("export const itemSearch", "const itemSearch")
    .replace("export default class ItemSearch", "globalThis.ItemSearch = class ItemSearch");

function fixture(){
    const requests = [];
    const timers = new Map();
    let timer = 0;
    const list = { hidden: true, innerHTML: "" };
    const attributes = new Map();
    const input = { id: "query", value: "", dataset: { itemSearch: "global" }, isConnected: true, setAttribute: (k, v) => attributes.set(k, v), removeAttribute: (k) => attributes.delete(k) };
    const context = vm.createContext({
        window: { setTimeout: (f) => { timers.set(++timer, f); return timer; } },
        clearTimeout: (id) => timers.delete(id),
        marketApi: { cached: (path) => new Promise((resolve, reject) => requests.push({ path, resolve, reject })) },
        identity: (item) => item.name,
        money: String,
    });
    vm.runInContext(source, context);
    const controller = new AbortController();
    const search = new context.ItemSearch({ addEventListener(){}, getElementById: () => list }, controller.signal, () => {}, () => {}, () => [{ skin: 1, name: "Star in inventory", fair: 10 }]);
    const type = (q) => { input.value = q; search.search(input); };
    const flush = () => { const callbacks = [...timers.values()]; timers.clear(); return callbacks.map((f) => f()); };
    return { search, input, list, attributes, requests, controller, type, flush };
}

const reply = (skin, name) => ({ items: [{ skin, name, fair: 100 }] });

describe("market item suggestions", () => {
    test("debounces keystrokes into one unfiltered request", async() => {
        const f = fixture();
        f.type("S"); f.type("St"); f.type("Star");
        const work = f.flush();
        expect(f.requests.map((r) => r.path)).toEqual(["/market/search?q=Star&sort=volume&page=1"]);
        f.requests[0].resolve(reply(1, "Star"));
        await Promise.all(work);
        expect(f.list.innerHTML).toContain("Star");
    });

    test("an older response cannot replace newer suggestions, even for the same query", async() => {
        const f = fixture();
        f.type("Star"); const first = f.flush();
        f.type("Frost"); f.type("Star"); const second = f.flush();
        f.requests[1].resolve(reply(2, "New result"));
        await Promise.all(second);
        f.requests[0].resolve(reply(1, "Old result"));
        await Promise.all(first);
        expect(f.list.innerHTML).toContain("New result");
        expect(f.list.innerHTML).not.toContain("Old result");
    });

    test("clearing, dismissing, and closing invalidate pending responses", async() => {
        for (const action of ["clear", "dismiss", "abort"]){
            const f = fixture();
            f.type("Star"); const work = f.flush();
            if (action === "clear") f.type("");
            else if (action === "abort") f.controller.abort();
            else f.search.dismiss();
            f.requests[0].resolve(reply(1, "Late result"));
            await Promise.all(work);
            expect(f.list.hidden).toBe(true);
            expect(f.attributes.get("aria-expanded")).toBe("false");
            expect(f.search.items).toHaveLength(0);
        }
    });

    test("a failed request is distinct from an empty search and can recover", async() => {
        const f = fixture();
        f.type("Star"); const failed = f.flush();
        f.requests[0].reject(Error("offline"));
        await Promise.all(failed);
        expect(f.list.innerHTML).toContain("Search unavailable");
        f.type("Absent"); const empty = f.flush();
        f.requests[1].resolve({ items: [] });
        await Promise.all(empty);
        expect(f.list.innerHTML).toContain("No matching items");
        f.type("Star"); const recovered = f.flush();
        f.requests[2].resolve(reply(1, "Star"));
        await Promise.all(recovered);
        expect(f.search.items).toHaveLength(1);
    });

    test("inventory suggestions use owned items without a market request", async() => {
        const f = fixture();
        f.input.dataset.itemSearch = "holdings";
        f.type("sTaR");
        await Promise.all(f.flush());
        expect(f.requests).toHaveLength(0);
        expect(f.list.innerHTML).toContain("Your holdings");
        expect(f.search.items.map((i) => i.skin)).toEqual([1]);
    });
});
