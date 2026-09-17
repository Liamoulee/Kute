// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

// What the client may send after an auto-detect run, and nothing else. The endpoint is open to the internet,
// so a report is not stored as it arrives: it is rebuilt from the fields below, with every string cut to a
// length, every number checked, and every unknown key dropped. Anything that does not fit is rejected.
// The shape mirrors `Report` in src/frontend/modules/autoDetect/index.js of the client.

export type MeasuredSetting = {
    id: string;
    current: string;
    cheap: string;
    gain: number | null;
    steady: boolean;
    note: string | null;
};

export type ClientResult = {
    config: string;
    hook: boolean;
    capped: boolean;
    throttled: boolean;
    fps: number;
    p99: number;
};

export type Change = {
    scope: "game" | "client";
    id: string;
    value: string;
    reason: string;
};

export type Report = {
    kute: string;
    // the how-manieth auto-detect run on that install, 0 when the client did not say. not an id: it only tells
    // first runs from repeats
    run: number;
    gpu: string;
    cpu: string;
    hz: number;
    laptop: boolean;
    baseFps: number;
    p50: number;
    p99: number;
    presentFps: number;
    noise: number;
    drift: number;
    halfResolutionGain: number | null;
    finalFps: number | null;
    seconds: number;
    settings: MeasuredSetting[];
    client: ClientResult[];
    clientNote: string;
    plan: {
        goal: number;
        needed: number;
        holds: boolean;
        regime: "cpu" | "gpu" | "unknown";
        healthy: boolean;
        predictedFps: number;
        changes: Change[];
    };
};

class Invalid extends Error {}

type Dict = Record<string, unknown>;

function dict(value: unknown, what: string): Dict {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Invalid(what + " must be an object");
    return value as Dict;
}

function text(value: unknown, what: string, max: number): string {
    if (typeof value !== "string") throw new Invalid(what + " must be a string");
    // printable characters only: this ends up in a database and maybe one day in a table on a page
    const printable = [...value].filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127 && char !== "<" && char !== ">");
    return printable.join("").trim().slice(0, max);
}

function number(value: unknown, what: string, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Invalid(what + " is out of range");
    return value;
}

function numberOrNull(value: unknown, what: string, min: number, max: number): number | null {
    return value === null || value === undefined ? null : number(value, what, min, max);
}

function flag(value: unknown, what: string): boolean {
    if (typeof value !== "boolean") throw new Invalid(what + " must be true or false");
    return value;
}

function list(value: unknown, what: string, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) throw new Invalid(what + " must be a list of at most " + max);
    return value;
}

function oneOf<T extends string>(value: unknown, what: string, allowed: readonly T[]): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) throw new Invalid(what + " must be one of " + allowed.join(", "));
    return value as T;
}

const FPS_MAX = 100000;
const MS_MAX = 60000;

/**
 * @returns The cleaned report, or a string that says what is wrong with it
 */
export function parseReport(body: unknown): Report | string {
    try {
        const raw = dict(body, "report");
        const plan = dict(raw.plan, "plan");

        return {
            kute: text(raw.kute, "kute", 24),
            run: raw.run === undefined ? 0 : number(raw.run, "run", 0, 100000),
            gpu: text(raw.gpu, "gpu", 160),
            cpu: text(raw.cpu, "cpu", 160),
            hz: number(raw.hz, "hz", 1, 2000),
            laptop: flag(raw.laptop, "laptop"),
            baseFps: number(raw.baseFps, "baseFps", 0, FPS_MAX),
            p50: number(raw.p50, "p50", 0, MS_MAX),
            p99: number(raw.p99, "p99", 0, MS_MAX),
            presentFps: number(raw.presentFps, "presentFps", 0, FPS_MAX),
            noise: number(raw.noise, "noise", 0, 100),
            drift: number(raw.drift, "drift", 0, 100),
            halfResolutionGain: numberOrNull(raw.halfResolutionGain, "halfResolutionGain", 0, 100),
            finalFps: numberOrNull(raw.finalFps, "finalFps", 0, FPS_MAX),
            seconds: number(raw.seconds, "seconds", 0, 3600),
            settings: list(raw.settings, "settings", 64).map((entry, index) => {
                const setting = dict(entry, "settings[" + index + "]");
                return {
                    id: text(setting.id, "setting id", 40),
                    current: text(setting.current, "setting current", 24),
                    cheap: text(setting.cheap, "setting cheap", 24),
                    gain: numberOrNull(setting.gain, "setting gain", 0, 100),
                    steady: flag(setting.steady, "setting steady"),
                    note: setting.note === undefined || setting.note === null ? null : text(setting.note, "setting note", 80),
                };
            }),
            client: list(raw.client, "client", 16).map((entry, index) => {
                const result = dict(entry, "client[" + index + "]");
                return {
                    config: text(result.config, "client config", 80),
                    hook: flag(result.hook, "client hook"),
                    capped: flag(result.capped, "client capped"),
                    throttled: flag(result.throttled, "client throttled"),
                    fps: number(result.fps, "client fps", 0, FPS_MAX),
                    p99: number(result.p99, "client p99", 0, MS_MAX),
                };
            }),
            clientNote: text(raw.clientNote ?? "", "clientNote", 240),
            plan: {
                goal: number(plan.goal, "plan goal", 0, FPS_MAX),
                needed: number(plan.needed, "plan needed", 0, FPS_MAX),
                holds: flag(plan.holds, "plan holds"),
                regime: oneOf(plan.regime, "plan regime", ["cpu", "gpu", "unknown"] as const),
                healthy: flag(plan.healthy, "plan healthy"),
                predictedFps: number(plan.predictedFps, "plan predictedFps", 0, FPS_MAX),
                changes: list(plan.changes, "plan changes", 64).map((entry, index) => {
                    const change = dict(entry, "changes[" + index + "]");
                    return {
                        scope: oneOf(change.scope, "change scope", ["game", "client"] as const),
                        id: text(change.id, "change id", 40),
                        value: text(String(change.value), "change value", 24),
                        reason: text(change.reason, "change reason", 120),
                    };
                }),
            },
        };
    }
    catch (error){
        if (error instanceof Invalid) return error.message;
        throw error;
    }
}
