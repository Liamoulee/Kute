// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

// What the client may send after an auto-detect run, and nothing else. The endpoint is open to the internet,
// so a report is not stored as it arrives: it is rebuilt from the fields below, with every string cut to a
// length, every number checked, and every unknown key dropped. Anything that does not fit is rejected.
// The shape mirrors `Report` in src/frontend/modules/autoDetect/index.js of the client.
//
// Everything in here describes a machine and a measurement. Nothing describes a person: no names, no paths,
// no addresses, no ids. Keep it that way when adding fields (flag VALUES, for one, can hold a user's path,
// which is why the client only sends flag names).

export type MeasuredSetting = {
    id: string;
    current: string;
    cheap: string;
    gain: number | null;
    steady: boolean;
    note: string | null;
    // frames per second before, with the value flipped, and after
    raw: number[] | null;
    confirmGain: number | null;
};

export type Intervals = { p50: number; p99: number; max: number };

export type ClientResult = {
    config: string;
    hook: boolean;
    capped: boolean;
    throttled: boolean;
    fps: number;
    p50: number;
    p99: number;
    max: number;
    // the hook's own present intervals, null without the hook
    present: Intervals | null;
    taskDelayP99: number;
    limit: number;
};

export type Change = {
    scope: "game" | "client";
    id: string;
    value: string;
    reason: string;
};

export type Details = {
    system: {
        gpus: { name: string; vramMb: number; software: boolean }[];
        // the GPU the page really renders on, as WebGL names it
        renderer: string;
        threads: number;
        ramGb: number;
        osBuild: string;
        displays: { width: number; height: number; hz: number; hostsWindow: boolean }[];
        window: number[];
        canvas: number[];
        pixelRatio: number;
        onBattery: boolean;
        userFlags: string[];
        disabledDefaults: string[];
    };
    // the client settings the run happened under, as the client stores them
    clientSettings: Record<string, string | number | boolean>;
    game: { resolution: number; frameCap: number; map: string };
    baseline: {
        samples: number[];
        p50: number;
        p95: number;
        p99: number;
        p999: number;
        max: number;
        present: (Intervals & { arriveP99: number; samples: number }) | null;
    };
    halfResolution: number[];
    timings: { clientSeconds: number; lobbySeconds: number };
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
    // older clients do not send them
    details: Details | null;
};

export type Failure = {
    kute: string;
    stage: string;
    message: string;
    seconds: number;
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

function numberOr(value: unknown, fallback: number, what: string, min: number, max: number): number {
    return value === null || value === undefined ? fallback : number(value, what, min, max);
}

function flag(value: unknown, what: string): boolean {
    if (typeof value !== "boolean") throw new Invalid(what + " must be true or false");
    return value;
}

function list(value: unknown, what: string, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) throw new Invalid(what + " must be a list of at most " + max);
    return value;
}

function numbers(value: unknown, what: string, maxLength: number, min: number, max: number): number[] {
    return list(value, what, maxLength).map((entry) => number(entry, what, min, max));
}

function oneOf<T extends string>(value: unknown, what: string, allowed: readonly T[]): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) throw new Invalid(what + " must be one of " + allowed.join(", "));
    return value as T;
}

const FPS_MAX = 100000;
const MS_MAX = 60000;

function intervals(value: unknown, what: string): Intervals | null {
    if (value === null || value === undefined || value === false) return null;
    const raw = dict(value, what);
    return {
        p50: number(raw.p50, what + " p50", 0, MS_MAX),
        p99: number(raw.p99, what + " p99", 0, MS_MAX),
        max: number(raw.max, what + " max", 0, MS_MAX),
    };
}

// the client settings that touch performance. a fixed list: whatever else a client sends is not kept
const CLIENT_SETTINGS = ["hardFlip", "uncapFps", "gameFpsLimit", "throttle", "inMenuThrottle", "webviewPriority", "angleBackend", "colorProfile", "rawInput"];

function parseDetails(value: unknown): Details | null {
    if (value === null || value === undefined) return null;
    const raw = dict(value, "details");
    const system = dict(raw.system, "system");
    const game = dict(raw.game, "game");
    const baseline = dict(raw.baseline, "baseline");
    const timings = dict(raw.timings, "timings");
    const sentSettings = dict(raw.clientSettings, "clientSettings");
    const present = intervals(baseline.present, "baseline present");
    const presentRaw = present ? dict(baseline.present, "baseline present") : null;

    const clientSettings: Record<string, string | number | boolean> = {};
    for (const key of CLIENT_SETTINGS){
        const setting = sentSettings[key];
        if (typeof setting === "boolean") clientSettings[key] = setting;
        else if (typeof setting === "number" && Number.isFinite(setting)) clientSettings[key] = setting;
        else if (typeof setting === "string") clientSettings[key] = text(setting, "client setting", 32);
    }

    return {
        system: {
            gpus: list(system.gpus, "gpus", 8).map((entry) => {
                const gpu = dict(entry, "gpu");
                return {
                    name: text(gpu.name, "gpu name", 160),
                    vramMb: number(gpu.vramMb, "gpu vramMb", 0, 1024 * 1024),
                    software: flag(gpu.software, "gpu software"),
                };
            }),
            renderer: text(system.renderer, "renderer", 240),
            threads: number(system.threads, "threads", 0, 4096),
            ramGb: number(system.ramGb, "ramGb", 0, 65536),
            osBuild: text(system.osBuild, "osBuild", 16),
            displays: list(system.displays, "displays", 16).map((entry) => {
                const display = dict(entry, "display");
                return {
                    width: number(display.width, "display width", 0, 100000),
                    height: number(display.height, "display height", 0, 100000),
                    hz: number(display.hz, "display hz", 0, 2000),
                    hostsWindow: flag(display.hostsWindow, "display hostsWindow"),
                };
            }),
            window: numbers(system.window, "window", 2, 0, 100000),
            canvas: numbers(system.canvas, "canvas", 2, 0, 100000),
            pixelRatio: number(system.pixelRatio, "pixelRatio", 0, 16),
            onBattery: flag(system.onBattery, "onBattery"),
            userFlags: list(system.userFlags, "userFlags", 32).map((entry) => text(entry, "user flag", 200)),
            disabledDefaults: list(system.disabledDefaults, "disabledDefaults", 64).map((entry) => text(entry, "disabled default", 200)),
        },
        clientSettings,
        game: {
            resolution: number(game.resolution, "resolution", 0, 10),
            frameCap: number(game.frameCap, "frameCap", 0, FPS_MAX),
            map: text(game.map ?? "", "map", 60),
        },
        baseline: {
            samples: numbers(baseline.samples, "baseline samples", 64, 0, FPS_MAX),
            p50: number(baseline.p50, "baseline p50", 0, MS_MAX),
            p95: number(baseline.p95, "baseline p95", 0, MS_MAX),
            p99: number(baseline.p99, "baseline p99", 0, MS_MAX),
            p999: number(baseline.p999, "baseline p999", 0, MS_MAX),
            max: number(baseline.max, "baseline max", 0, MS_MAX),
            present: present && presentRaw
                ? {
                    ...present,
                    arriveP99: number(presentRaw.arriveP99, "present arriveP99", 0, MS_MAX),
                    samples: number(presentRaw.samples, "present samples", 0, 10000000),
                }
                : null,
        },
        halfResolution: numbers(raw.halfResolution, "halfResolution", 3, 0, FPS_MAX),
        timings: {
            clientSeconds: number(timings.clientSeconds, "clientSeconds", 0, 3600),
            lobbySeconds: number(timings.lobbySeconds, "lobbySeconds", 0, 3600),
        },
    };
}

/**
 * @returns The cleaned report, or a string that says what is wrong with it
 */
export function parseReport(body: unknown): Report | string {
    try {
        const raw = dict(body, "report");
        const plan = dict(raw.plan, "plan");

        return {
            kute: text(raw.kute, "kute", 24),
            run: numberOr(raw.run, 0, "run", 0, 100000),
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
                    raw: setting.raw === undefined || setting.raw === null ? null : numbers(setting.raw, "setting raw", 3, 0, FPS_MAX),
                    confirmGain: numberOrNull(setting.confirmGain, "setting confirmGain", 0, 100),
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
                    p50: numberOr(result.p50, 0, "client p50", 0, MS_MAX),
                    p99: number(result.p99, "client p99", 0, MS_MAX),
                    max: numberOr(result.max, 0, "client max", 0, MS_MAX),
                    present: intervals(result.present, "client present"),
                    taskDelayP99: numberOr(result.taskDelayP99, 0, "client taskDelayP99", 0, MS_MAX),
                    limit: numberOr(result.limit, 0, "client limit", 0, FPS_MAX),
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
            details: parseDetails(raw.details),
        };
    }
    catch (error){
        if (error instanceof Invalid) return error.message;
        throw error;
    }
}

/**
 * A run that did not get to a result: where it stopped and why.
 *
 * @returns The cleaned failure, or a string that says what is wrong with it
 */
export function parseFailure(body: unknown): Failure | string {
    try {
        const raw = dict(body, "failure");
        return {
            kute: text(raw.kute, "kute", 24),
            stage: oneOf(raw.stage, "stage", ["start", "client", "lobby", "measure", "apply"] as const),
            message: text(raw.message, "message", 200),
            seconds: number(raw.seconds, "seconds", 0, 3600),
        };
    }
    catch (error){
        if (error instanceof Invalid) return error.message;
        throw error;
    }
}
