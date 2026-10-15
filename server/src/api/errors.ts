// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

export class KrunkerError extends Error {
    constructor(message: string, options?: ErrorOptions){
        super(message, options);
        this.name = new.target.name;
    }
}

/** a call was made with an argument the api would reject, nothing was sent */
export class KrunkerArgumentError extends KrunkerError {}

/** no api key configured */
export class KrunkerConfigError extends KrunkerError {}

/** the request never got an http reply */
export class KrunkerNetworkError extends KrunkerError {
    readonly timeout: boolean;

    constructor(message: string, timeout: boolean, cause?: unknown){
        super(message, { cause });
        this.timeout = timeout;
    }
}

export class KrunkerHttpError extends KrunkerError {
    readonly status: number;
    readonly url: string;
    /** parsed error body, or the raw text when it was no json */
    readonly body: unknown;

    constructor(status: number, url: string, body: unknown, message?: string){
        super(message ?? `Krunker API ${status} for ${url}`);
        this.status = status;
        this.url = url;
        this.body = body;
    }
}

export class KrunkerBadRequestError extends KrunkerHttpError {}

/** the api key is invalid or revoked */
export class KrunkerForbiddenError extends KrunkerHttpError {}

export class KrunkerNotFoundError extends KrunkerHttpError {}

export class KrunkerRateLimitError extends KrunkerHttpError {
    /** seconds until the window resets */
    readonly retryAfter: number;
    /** true when the client refused to send because the window is known to be empty */
    readonly preemptive: boolean;

    constructor(url: string, retryAfter: number, body: unknown, preemptive = false){
        super(429, url, body, `Krunker API rate limit hit for ${url}, retry in ${retryAfter}s`);
        this.retryAfter = retryAfter;
        this.preemptive = preemptive;
    }
}

export class KrunkerServerError extends KrunkerHttpError {}

export const isNotFound = (err: unknown): err is KrunkerNotFoundError => err instanceof KrunkerNotFoundError;
export const isRateLimited = (err: unknown): err is KrunkerRateLimitError => err instanceof KrunkerRateLimitError;

/** retrying makes sense for these, the request itself was fine */
export const isTransient = (err: unknown): boolean =>
    err instanceof KrunkerNetworkError || err instanceof KrunkerServerError || err instanceof KrunkerRateLimitError;
