import { expect, test } from "bun:test";
import { itemIntelligence, dealEvidence } from "../src/frontend/modules/market/intelligence.js";

test("research prices stay hidden and signal content is escaped", () => {
    const html = itemIntelligence({ signals: [{ kind: "risk", tone: "negative", title: "<script>bad</script>", detail: "<img src=x>", strength: 80 }], score: 80, asOf: 1, outlook: { state: "learning", point: 987654, low: 987653, high: 987655, start: "2026-10-19", end: "2026-10-25", issuedAt: 1 } });
    expect(html).not.toContain("987");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("research forecast");
});

test("deal explanations escape attribute content and expose the first risk", () => {
    const html = dealEvidence({ assessment: { reasons: ['Good "price"'], risks: ["Concentrated listings", "Unstable prices"] } });
    expect(html).toContain("Concentrated listings +1 risk");
    expect(html).toContain("&quot;price&quot;");
});
