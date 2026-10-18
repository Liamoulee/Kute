import marketApi from "../api.js";
import { readWatchlist } from "../watchlist.js";
import { intelligenceView } from "../intelligence.js";
const MINUTE = 60_000;
/** @param {import("../terminal.js").Terminal} desk  @return {Promise<import("../terminal.js").View>} */
export async function researchView(desk){
    const kind = typeof desk.arg === "string" ? desk.arg : "";
    /** @type {import("../intelligence.js").IntelligenceReply|null} */
    const reply = await marketApi.cached(`/market/intelligence?kind=${encodeURIComponent(kind)}`, MINUTE);
    if (!reply) return desk.unavailable();
    return {
        asOf: reply.asOf,
        asOfLabel: "Analyzed",
        html: intelligenceView(reply, kind, desk.advanced, readWatchlist().map(w => w.skin)),
    };
}
