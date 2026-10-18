import { expect, test } from "bun:test";
import { itemIntelligence, dealEvidence, intelligenceView } from "../src/frontend/modules/market/intelligence.js";
import { element, markup } from "../src/frontend/modules/market/element.js";
import { contributionEvidence } from "../src/frontend/modules/market/contributionEvidence.js";

test("private exchange comparisons remain labeled and escape contributed display values", () => {
    const html = contributionEvidence({ trades30d: 8, sales30d: 6, matchedSales30d: 5, cash: { samples: 5, median: 100, low: 90, high: 110 }, sales: null, swaps: [{ skin: 2, name: '<img onerror="bad()">', samples: 5, median: 2, low: 1, high: 3 }] });
    expect(html).toContain("not a complete trade history");
    expect(html).toContain("median 100 KR");
    expect(html).not.toContain("<img");
    expect(contributionEvidence(undefined)).toBe("");
});

test("research prices stay hidden and signal content is escaped", () => {
    const html = itemIntelligence({ signals: [{ kind: "risk", tone: "negative", title: "<script>bad</script>", detail: "<img src=x>", strength: 80 }], score: 80, asOf: 1, outlook: { state: "learning", point: 987654, low: 987653, high: 987655, start: "2026-10-19", end: "2026-10-25", issuedAt: 1 } });
    expect(html).not.toContain("987");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("research forecast");
});

test("an item with only a private forecast has no intelligence placeholder", () => {
    const html = itemIntelligence({ signals: [], score: 0, asOf: 1, outlook: { state: "learning", point: null, low: null, high: null, start: null, end: null, issuedAt: 1 } });
    expect(html).toBe("");
});

test("deal explanations escape attribute content and expose the first risk", () => {
    const html = dealEvidence({ assessment: { reasons: ['Good "price"'], risks: ["Concentrated listings", "Unstable prices"] } });
    expect(html).toContain("Concentrated listings +1 risk");
    expect(html).toContain("&quot;price&quot;");
});

test("news actions have no popup anchors and escape feed content", () => {
    const html = intelligenceView({ items: [], model: null, coverage: { items: 0, dailyRows: 0, firstDay: null, lastDay: null, supplySince: null, contributedSales: 0 }, sources: [], asOf: 0,
        news: [{ title: '<img src=x onerror="oops">', url: 'https://example.com/?x="bad"', observedAt: 1 }],
    }, "", false, []);
    expect(html).toContain("data-external-url=");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('target="_blank"');
});

test("elements escape text and attributes unless markup is explicitly trusted", () => {
    expect(element("p", { title: '" onclick="bad' }, "<img>", markup("<b>safe</b>")))
        .toBe('<p title="&quot; onclick=&quot;bad">&lt;img&gt;<b>safe</b></p>');
});
