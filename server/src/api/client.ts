import Log from "../util/log";
import {
    KrunkerBadRequestError,
    KrunkerConfigError,
    KrunkerForbiddenError,
    KrunkerHttpError,
    KrunkerNetworkError,
    KrunkerNotFoundError,
    KrunkerRateLimitError,
    KrunkerServerError,
    KrunkerUnauthorizedError,
} from "./errors";
import { GLOBAL_LIMIT, RateLimitTracker } from "./rateLimit";
import type { ApiErrorBody } from "./types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export const DEFAULT_BASE_URL = "https://gapi.svc.krunker.io";
// market/skin ran past 10 s cold and 2.7 s warm on 2026-10-15, the rest answers in 0.2 to 0.7 s
const DEFAULT_TIMEOUT_MS = 20 * 1000;
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 300;
/** a known empty window this short is waited out instead of refused */
const SHORT_WAIT_S = 2;
/** below this share of the window left, every reply logs a warning */
const LOW_REMAINING_SHARE = 0.1;

export type ClientOptions = {
    /** omitted for the keyless endpoints, empty means not configured */
    apiKey?: string;
    baseUrl?: string;
    timeoutMs?: number;
    /** extra attempts after a network error or a 5xx, never after a 4xx */
    retries?: number;
    userAgent?: string;
    fetch?: typeof fetch;
};

export type QueryValue = string | number | undefined;

export type RequestOptions = {
    /** stable name of the endpoint, the key for its own rate limit window */
    route: string;
    query?: Record<string, QueryValue>;
    /** per call headers, the token wrapper's Authorization; never logged */
    headers?: Record<string, string>;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isTimeout = (err: unknown): boolean => err instanceof Error && err.name === "TimeoutError";

async function readBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}

// developer api: {error: "text"}, a 404 as plain "Not Found"; keyless gapi: {error: {code, message}}
const errorMessage = (body: unknown): string | null => {
    if (typeof body === "string") return body.length <= 120 ? body : null;
    if (typeof body !== "object" || body === null) return null;
    const { error } = body as ApiErrorBody;
    if (typeof error === "string") return error;
    if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
    return null;
};

export class KrunkerClient {
    readonly rateLimit = new RateLimitTracker();
    readonly #apiKey: string | undefined;
    readonly #baseUrl: string;
    readonly #timeoutMs: number;
    readonly #retries: number;
    readonly #userAgent: string | undefined;
    readonly #fetch: typeof fetch;

    constructor(options: ClientOptions){
        this.#apiKey = options.apiKey;
        this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.#retries = options.retries ?? DEFAULT_RETRIES;
        this.#userAgent = options.userAgent;
        this.#fetch = options.fetch ?? fetch;
    }

    get configured(): boolean {
        return this.#apiKey === undefined || this.#apiKey.length > 0;
    }

    url(path: string, query?: Record<string, QueryValue>): string {
        const url = new URL(this.#baseUrl + path);
        for (const [key, value] of Object.entries(query ?? {})){
            if (value !== undefined) url.searchParams.set(key, String(value));
        }
        return url.toString();
    }

    async get<T>(path: string, options: RequestOptions): Promise<T> {
        if (!this.configured) throw new KrunkerConfigError("krunker_api_token is not set in config.custom.ts");

        const url = this.url(path, options.query);
        const blocked = this.rateLimit.blockedFor(options.route);
        // gapi's per second windows are over before a caller could do anything else with the refusal
        if (blocked > 0 && blocked <= SHORT_WAIT_S) await sleep(blocked * 1000);
        else if (blocked > 0) throw new KrunkerRateLimitError(url, blocked, null, true);

        for (let attempt = 0; ; attempt++){
            try {
                return await this.#send<T>(url, options.route, options.headers);
            }
            catch (err){
                const retry = attempt < this.#retries && (err instanceof KrunkerNetworkError || err instanceof KrunkerServerError);
                if (!retry) throw err;
                Log.debug(`krunker api: retrying ${url} after ${(err as Error).message}`);
                await sleep(RETRY_DELAY_MS * (attempt + 1));
            }
        }
    }

    async #send<T>(url: string, route: string, extra?: Record<string, string>): Promise<T> {
        const headers: Record<string, string> = { Accept: "application/json", ...extra };
        if (this.#apiKey) headers["X-Developer-API-Key"] = this.#apiKey;
        if (this.#userAgent) headers["User-Agent"] = this.#userAgent;

        const started = performance.now();
        let res: Response;
        try {
            res = await this.#fetch(url, { headers, signal: AbortSignal.timeout(this.#timeoutMs) });
        }
        catch (err){
            const timeout = isTimeout(err);
            throw new KrunkerNetworkError(timeout ? `Krunker API timed out after ${this.#timeoutMs}ms for ${url}` : `Krunker API unreachable for ${url}`, timeout, err);
        }

        const window = this.rateLimit.observe(route, res.headers);
        const body = await readBody(res);
        Log.debug(`krunker api: ${res.status} ${url} in ${Math.round(performance.now() - started)}ms` + (window ? ` (${window.remaining}/${window.limit} left)` : ""));
        if (window && window.remaining <= window.limit * LOW_REMAINING_SHARE){
            Log.warn(`krunker api: ${window.remaining} of ${window.limit} requests left on ${window.limit < GLOBAL_LIMIT ? route : "the key"} until ${new Date(window.resetAt).toISOString()}`);
        }

        if (res.ok) return body as T;
        throw this.#httpError(res, url, route, body);
    }

    #httpError(res: Response, url: string, route: string, body: unknown): KrunkerHttpError {
        const message = errorMessage(body);
        const text = message ? `Krunker API ${res.status} for ${url}: ${message}` : undefined;
        switch (res.status){
            case 400: return new KrunkerBadRequestError(res.status, url, body, text);
            case 401: return new KrunkerUnauthorizedError(res.status, url, body, text);
            case 403: return new KrunkerForbiddenError(res.status, url, body, text);
            case 404: return new KrunkerNotFoundError(res.status, url, body, text);
            case 429: {
                const fromBody = (body as ApiErrorBody | null)?.retry_after;
                const fromHeader = parseInt(res.headers.get("Retry-After") ?? "", 10);
                const retryAfter = Math.max(1, Math.ceil(fromBody ?? fromHeader) || 1);
                this.rateLimit.exhaust(route, retryAfter);
                return new KrunkerRateLimitError(url, retryAfter, body);
            }
            default:
                if (res.status >= 500) return new KrunkerServerError(res.status, url, body, text);
                return new KrunkerHttpError(res.status, url, body, text);
        }
    }
}
