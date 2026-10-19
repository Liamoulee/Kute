import { config } from "../../config/config";
import { isDevelopment } from "./env";
import Log from "./log";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// the owner's discord webhook (config.log_webhook) for things that need a human: krunker refusing our
// requests, a sweep that keeps failing. never player data, never the key, never an address

export type AlertLevel = "info" | "warn" | "error";

const COLORS: Record<AlertLevel, number> = { info: 0x5865f2, warn: 0xfee75c, error: 0xed4245 };
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
/** discord's embed description limit */
const MAX_DESCRIPTION = 4000;

const lastSent = new Map<string, number>();

/** true while the key is inside its cooldown, so the caller can skip the work of building a message */
export function alertMuted(key: string, cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now()): boolean {
    const last = lastSent.get(key);
    return last !== undefined && now - last < cooldownMs;
}

/**
 * posts one embed to the webhook, at most once per key within the cooldown; fire and forget, a failure
 * of the webhook itself is only logged. without a webhook configured the message goes to the log alone
 */
export function notify(key: string, title: string, lines: string[], level: AlertLevel = "warn", cooldownMs = DEFAULT_COOLDOWN_MS): void {
    const now = Date.now();
    if (alertMuted(key, cooldownMs, now)) return;
    lastSent.set(key, now);

    const text = lines.join("\n").slice(0, MAX_DESCRIPTION);
    const line = `alert ${key}: ${title}` + (text ? ` (${lines[0]})` : "");
    if (level === "error") Log.error(line);
    else if (level === "warn") Log.warn(line);
    else Log.info(line);

    const url = config.log_webhook;
    if (!url) return;
    const body = {
        embeds: [{
            title: (isDevelopment ? "[dev] " : "") + title.slice(0, 256),
            description: text,
            color: COLORS[level],
            timestamp: new Date(now).toISOString(),
        }],
    };
    fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    }).then((res) => {
        if (!res.ok) Log.warn(`alert webhook answered ${res.status}`);
    }).catch((err: Error) => Log.warn(`alert webhook failed: ${err.message}`));
}

/** lets a key fire again, for a "recovered" message that must follow its alert at once */
export function resetAlert(key: string): void {
    lastSent.delete(key);
}
