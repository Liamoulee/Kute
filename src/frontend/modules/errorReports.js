import { kute, ready } from "../client.js";
import api from "./api.js";

const BUNDLE_NAME = "bundle.js";
const MAX_REPORTS = 3;

/** @type {Set<string>} */
const seen = new Set();

/**
 * @param {string} text
 * @param {number} max
 * @return {string} Without the user's folder (it names the Windows account), cut to max
 */
function clean(text, max){
    return text.replace(/[a-z]:[\\/]+users[\\/]+[^\\/\s:"']+/gi, "~").slice(0, max);
}

/**
 * @param {string} message
 * @param {string} location
 * @param {string} stack
 */
async function report(message, location, stack){
    try {
        if (seen.size >= MAX_REPORTS || seen.has(message)) return;
        seen.add(message);
        await ready;
        if (kute.settings.data.telemetry === false || !await api.available()) return;
        const body = {
            kute: kute.version,
            bundle: KUTE_BUNDLE_VERSION,
            location: clean(location, 200),
            message: clean(message, 400),
            trace: clean(stack, 3000),
        };
        window.chrome.webview.postMessage(`telemetry client-error ${JSON.stringify(body)}`);
    }
    catch {
        // an error report must never be the reason for the next error
    }
}

/**
 * Our wrappers of Krunker's UI functions (showWindow, ...) sit in the middle of Krunker's own call stacks, so
 * "bundle.js is somewhere in the stack" also caught Krunker's errors (PureJSCarousel). Ours is what threw: the top frame.
 *
 * @param {string} stack
 * @return {boolean}
 */
function thrownByBundle(stack){
    const top = stack.split("\n").find((line) => line.trimStart().startsWith("at "));
    return top?.includes(BUNDLE_NAME) ?? false;
}

window.addEventListener("error", (event) => {
    const stack = String(event.error?.stack ?? "");
    if (!String(event.filename).includes(BUNDLE_NAME) && !thrownByBundle(stack)) return;
    report(String(event.message), `${event.filename}:${event.lineno}:${event.colno}`, stack);
});

window.addEventListener("unhandledrejection", (event) => {
    const stack = String(event.reason?.stack ?? "");
    if (!thrownByBundle(stack)) return;
    report(String(event.reason?.message ?? event.reason), "promise", stack);
});
