import { esc, money } from "./presentation.js";

/** @type {Record<string,string>} */
const BASELINES = { sales7d: "7-day public sales", sales30d: "30-day public sales", sales90d: "90-day public sales", ask: "Sampled asking prices", krunker: "Krunker estimate", floor: "Fallback estimate" };

/** @param {import("./types.js").SkinValue} skin @param {boolean} advanced */
export function exchangeEvidence(skin, advanced){
    const e = skin.exchange;
    if (!e && !skin.privateTrading?.trades30d) return "";
    const applied = e?.status === "applied";
    return `<section class="sectionGap panel" id="kmExchangeValue">
        <div class="panelHead"><h3>${applied ? "Private trades contribute to this value" : "Private trading activity"}</h3>
        <span class="tag quiet">${applied && e.confidence < 35 ? "Tentative evidence" : "Reported exchanges"}</span></div>
        ${applied ? `<p>${money(e.reports)} eligible exchanges inform the <b>${money(skin.fair)} KR</b> Kute estimate.
        The model uses quantities on both sides, KR payments and public sale values to price supported bundles.</p>` : `<p>${money(skin.privateTrading?.trades30d ?? 0)} reported exchanges in the last 30 days.
        ${esc(e?.reason ?? "These reports establish activity; their currencies or instance attributes do not yet support a base-item KR estimate.")}</p>`}
        ${skin.privateTrading ? `<p class="sub">${money(skin.privateTrading.trades7d)} private trades in seven days. Latest reported trade date: ${esc(skin.privateTrading.lastTradeDay)} UTC.</p>` : ""}
        ${advanced && applied ? `<div class="metricsGap metrics">
            <div class="metric"><span>Public-data baseline</span><strong>${money(e.baseline)} <span class="unit">KR</span></strong><small>${esc(BASELINES[e.baselineMethod] ?? "Public evidence")}</small></div>
            <div class="metric"><span>Model sensitivity range</span><strong>${money(e.low)} to ${money(e.high)}</strong><small>KR; not a calibrated prediction interval</small></div>
            <div class="metric"><span>Report diversity</span><strong>${esc(e.sources)} source${e.sources === 1 ? "" : "s"} / ${esc(e.days)} day${e.days === 1 ? "" : "s"}</strong><small>Anonymous sessions, not verified unique players</small></div>
        </div>` : ""}
        <p class="chartNote">Client reports can be incomplete or inaccurate. A verdict needs sufficient combined public and private evidence.
        Private trading does not establish cash-sale liquidity. The letter grade still describes public-market activity.</p>
    </section>`;
}
