import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/frontend/modules/market/alerts.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/^export const /gm, "const ")
    .replace("export default alerts;", "globalThis.alerts = alerts;");

function fixture(){
    const notifications = [];
    const data = { lowest: 90, bookAt: Date.now(), valuedAt: Date.now() };
    const watch = [{ skin: 1, name: "Fixture", target: 100 }];
    let calls = 0;
    let badgeEvents = 0;
    let offline = false;
    const storage = new Map();
    const context = vm.createContext({
        document: { pointerLockElement: null, hidden: false },
        window: { setInterval: () => 1, addEventListener(){}, removeEventListener(){}, dispatchEvent: () => { badgeEvents++; } },
        Event: class { constructor(type){ this.type = type; } },
        clearInterval(){},
        localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
        kute: { showNotification: (...args) => notifications.push(args) },
        api: { offline: () => offline },
        marketApi: { loggedIn: () => true, values: async() => { calls++; return { 1: { ...data } }; } },
        readWatchlist: () => watch,
        formatKr: String,
    });
    vm.runInContext(source, context);
    context.alerts.timer = 1;
    return { context, alerts: context.alerts, data, watch, notifications, calls: () => calls, badgeEvents: () => badgeEvents, setOffline: (v) => { offline = v; } };
}

describe("watchlist menu alerts", () => {
    test("skip every request during gameplay, hidden pages, offline mode, and after stop", async() => {
        const f = fixture();
        f.context.document.pointerLockElement = {};
        await f.alerts.check();
        f.context.document.pointerLockElement = null;
        f.context.document.hidden = true;
        await f.alerts.check();
        f.context.document.hidden = false;
        f.setOffline(true);
        await f.alerts.check();
        f.setOffline(false);
        f.alerts.stop();
        await f.alerts.check();
        expect(f.calls()).toBe(0);
    });

    test("notify once per target crossing, then rearm when the ask rises", async() => {
        const f = fixture();
        await f.alerts.check();
        await f.alerts.check();
        expect(f.notifications).toHaveLength(1);
        f.data.lowest = 120;
        await f.alerts.check();
        f.data.lowest = 95;
        await f.alerts.check();
        expect(f.notifications).toHaveLength(2);
        f.watch[0].target = 110;
        await f.alerts.check();
        expect(f.notifications).toHaveLength(3);
    });

    test("a crossing counts as unread until the watchlist is opened, and a removed watch drops it", async() => {
        const f = fixture();
        await f.alerts.check();
        expect([...f.alerts.unread]).toEqual([1]);
        expect(f.badgeEvents()).toBe(1);
        await f.alerts.check();
        expect(f.badgeEvents()).toBe(1);
        f.alerts.markRead();
        expect(f.alerts.unread.size).toBe(0);
        expect(f.badgeEvents()).toBe(2);
        f.data.lowest = 120;
        await f.alerts.check();
        f.data.lowest = 95;
        await f.alerts.check();
        expect(f.alerts.unread.size).toBe(1);
        f.watch[0].target = null;
        await f.alerts.check();
        expect(f.alerts.unread.size).toBe(0);
    });

    test("stale or unobserved quotes never trigger a target alert", async() => {
        const f = fixture();
        f.data.bookAt = Date.now() - 4 * 3_600_000;
        await f.alerts.check();
        f.data.bookAt = null;
        await f.alerts.check();
        expect(f.notifications).toHaveLength(0);
    });

    test("a response arriving after gameplay starts cannot notify", async() => {
        const f = fixture();
        let finish;
        f.context.marketApi.values = () => new Promise((resolve) => { finish = resolve; });
        const pending = f.alerts.check();
        f.context.document.pointerLockElement = {};
        finish({ 1: f.data });
        await pending;
        expect(f.notifications).toHaveLength(0);
    });

    test("saved crossing state prevents repeat alerts after a page reload", async() => {
        const f = fixture();
        await f.alerts.check();
        const next = vm.createContext({ ...f.context });
        vm.runInContext(source, next);
        next.alerts.timer = 1;
        await next.alerts.check();
        expect(f.notifications).toHaveLength(1);
    });

    test("removing the last watch clears its saved crossing before a reload", async() => {
        const f = fixture();
        await f.alerts.check();
        const removed = f.watch.pop();
        await f.alerts.check();
        f.watch.push(removed);
        const next = vm.createContext({ ...f.context });
        vm.runInContext(source, next);
        next.alerts.timer = 1;
        await next.alerts.check();
        expect(f.notifications).toHaveLength(2);
    });
});
