import type { FetchLike } from "krapio";
import { notify, resetAlert } from "../util/alert";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// watches every reply krunker gives us and tells the owner when they stop coming: a refused key, an
// address block, an outage. it sits under krapio as its fetch, so no tier and no caller can bypass it

type Outcome = "ok" | "denied" | "rateLimited" | "server" | "network" | "other";
type Sample = { at: number; outcome: Outcome; developer: boolean };

/** how far back a verdict looks */
const WINDOW_MS = 10 * 60 * 1000;
/** fewer replies than this say nothing */
const MIN_SAMPLES = 20;
const FAILING_SHARE = 0.5;
const RATE_LIMITED_SHARE = 0.5;
const RECOVERED_SHARE = 0.1;
const COOLDOWN_MS = 60 * 60 * 1000;

const outcomeOf = (status: number): Outcome => {
    if (status < 400) return "ok";
    if (status === 401 || status === 403) return "denied";
    if (status === 429) return "rateLimited";
    if (status >= 500) return "server";
    return "other";
};

export class ApiHealth {
    #samples: Sample[] = [];
    readonly #active = new Set<string>();
    #lastStatus = 0;
    #lastUrl = "";

    /** wraps a fetch so every krunker reply is counted; the response itself is untouched */
    wrap(inner: FetchLike): FetchLike {
        return async(input, init) => {
            const developer = input.includes("/api/");
            try {
                const res = await inner(input, init);
                this.record(outcomeOf(res.status), developer, res.status, input);
                return res;
            }
            catch (err){
                this.record("network", developer, 0, input);
                throw err;
            }
        };
    }

    record(outcome: Outcome, developer: boolean, status: number, url: string, now = Date.now()): void {
        this.#samples.push({ at: now, outcome, developer });
        if (outcome !== "ok"){
            this.#lastStatus = status;
            // the path only, a query could carry a player name
            this.#lastUrl = url.split("?")[0] ?? url;
        }
        const cutoff = now - WINDOW_MS;
        while (this.#samples.length && this.#samples[0]!.at < cutoff) this.#samples.shift();
        this.#judge(outcome, developer, now);
    }

    /** the window as numbers, for the status route */
    snapshot(now = Date.now()): { total: number; failed: number; rateLimited: number; denied: number; alerts: string[] } {
        const cutoff = now - WINDOW_MS;
        let total = 0;
        let failed = 0;
        let rateLimited = 0;
        let denied = 0;
        for (const s of this.#samples){
            if (s.at < cutoff) continue;
            total++;
            if (s.outcome === "rateLimited") rateLimited++;
            else if (s.outcome !== "ok"){
                failed++;
                if (s.outcome === "denied") denied++;
            }
        }
        return { total, failed, rateLimited, denied, alerts: [...this.#active] };
    }

    #judge(outcome: Outcome, developer: boolean, now: number): void {
        // a refused key is never noise, the first one counts
        if (outcome === "denied" && developer) this.#raise("krunker-denied", "Krunker refused the developer key", [`${this.#lastStatus} on ${this.#lastUrl}`, "the key may be revoked or the address blocked"], "error");
        else if (outcome === "ok" && developer) this.#recover("krunker-denied", "Krunker accepts the developer key again", ["a developer request succeeded"]);

        const { total, failed, rateLimited } = this.snapshot(now);
        if (total < MIN_SAMPLES) return;
        const describe = (): string[] => [
            `last 10 min: ${total} requests, ${failed} failed, ${rateLimited} rate limited`,
            `last failure: ${this.#lastStatus || "no reply"} on ${this.#lastUrl}`,
        ];
        if (failed / total >= FAILING_SHARE) this.#raise("krunker-failing", "Krunker API requests are failing", describe(), "error");
        else if (failed / total < RECOVERED_SHARE) this.#recover("krunker-failing", "Krunker API requests succeed again", describe());

        if (rateLimited / total >= RATE_LIMITED_SHARE) this.#raise("krunker-ratelimited", "Krunker rate limits most of our requests", [...describe(), "more than the sweeps' own pacing explains, the address may be throttled"], "warn");
        else if (rateLimited / total < RECOVERED_SHARE) this.#recover("krunker-ratelimited", "Krunker rate limits are back to normal", describe());
    }

    #raise(key: string, title: string, lines: string[], level: "warn" | "error"): void {
        this.#active.add(key);
        notify(key, title, lines, level, COOLDOWN_MS);
    }

    #recover(key: string, title: string, lines: string[]): void {
        if (!this.#active.delete(key)) return;
        resetAlert(key);
        notify(key, title, lines, "info", 0);
        // the next problem may come right after a recovery
        resetAlert(key);
    }
}

export const apiHealth = new ApiHealth();
