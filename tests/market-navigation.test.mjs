import { expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";
import { TITLES, DISCOVERY_TABS } from "../src/frontend/modules/market/navigation.js";

test("news actions use only HTTPS URLs through the native browser bridge", () => {
    const messages = []; const notices = [];
    class Element {
        constructor(url){ this.dataset = { externalUrl: url }; }
        closest(){ return this; }
        hasAttribute(){ return false; }
    }
    const source = fs.readFileSync(new URL("../src/frontend/modules/market/terminal.js", import.meta.url), "utf8")
        .replace(/^import .*;\r?\n/gm, "").replace("export class Terminal", "class Terminal")
        .replace("export default terminal;", "globalThis.terminal = terminal;");
    const context = vm.createContext({ Element, URL, TITLES, DISCOVERY_TABS,
        kute: { hostFeatures: ["krunker-links"], showNotification: message => notices.push(message) },
        localStorage: { getItem: () => null }, window: { chrome: { webview: { postMessage: (message) => messages.push(message) } } },
    });
    vm.runInContext(source, context);
    // eslint-disable-next-line no-script-url -- rejected feed fixture
    for (const url of ["https://krunker.io/news", "https://github.com/NullDev/Kute", "https://krunker.io.evil.test/news", "javascript:alert(1)", "http://example.com", "https://user:pass@example.com", "bad url"]){
        context.terminal.click({ target: new Element(url), preventDefault(){} });
    }
    expect(messages).toEqual(["open-url, https://krunker.io/news", "open-url, https://github.com/NullDev/Kute"]);
    context.kute.hostFeatures = [];
    context.terminal.click({ target: new Element("https://krunker.io/news"), preventDefault(){} });
    expect(messages).toHaveLength(2);
    expect(notices.at(-1)).toContain("Update the Kute application");
    expect(DISCOVERY_TABS).toContain("intelligence");
    expect(TITLES.intelligence).toBe("Discover");
});
