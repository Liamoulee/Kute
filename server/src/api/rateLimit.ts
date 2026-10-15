// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

/** the per key limit every endpoint shares; a reply showing a smaller limit is an endpoint's own window */
export const GLOBAL_LIMIT = 240;

export type RateLimitWindow = {
    limit: number;
    remaining: number;
    /** unix ms */
    resetAt: number;
};

export type RateLimitState = {
    global: RateLimitWindow | null;
    /** endpoints with a limit of their own, keyed by route name */
    routes: Record<string, RateLimitWindow>;
};

const headerInt = (headers: Headers, name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
};

/** mirrors the X-RateLimit-* headers so a call can be refused before it costs a request */
export class RateLimitTracker {
    #global: RateLimitWindow | null = null;
    readonly #routes = new Map<string, RateLimitWindow>();

    observe(route: string, headers: Headers): RateLimitWindow | null {
        const limit = headerInt(headers, "X-RateLimit-Limit");
        const remaining = headerInt(headers, "X-RateLimit-Remaining");
        const reset = headerInt(headers, "X-RateLimit-Reset");
        if (limit === null || remaining === null || reset === null) return null;

        const window = { limit, remaining, resetAt: reset * 1000 };
        if (limit >= GLOBAL_LIMIT) this.#global = window;
        else this.#routes.set(route, window);
        return window;
    }

    /** seconds to wait before a request on this route can succeed, 0 when it may go out now */
    blockedFor(route: string, now = Date.now()): number {
        let wait = 0;
        for (const window of [this.#global, this.#routes.get(route)]){
            if (!window || window.remaining > 0 || window.resetAt <= now) continue;
            wait = Math.max(wait, Math.ceil((window.resetAt - now) / 1000));
        }
        return wait;
    }

    /** a 429 without usable headers still has to block until retry_after passes */
    exhaust(route: string, retryAfterSeconds: number, now = Date.now()): void {
        const resetAt = now + retryAfterSeconds * 1000;
        const current = this.#routes.get(route);
        if (current && current.limit < GLOBAL_LIMIT) this.#routes.set(route, { ...current, remaining: 0, resetAt });
        else this.#global = { limit: this.#global?.limit ?? GLOBAL_LIMIT, remaining: 0, resetAt };
    }

    snapshot(): RateLimitState {
        return {
            global: this.#global ? { ...this.#global } : null,
            routes: Object.fromEntries([...this.#routes].map(([route, window]) => [route, { ...window }])),
        };
    }
}
