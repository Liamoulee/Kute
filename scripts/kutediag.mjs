import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// bun scripts/kutediag.mjs <report.kutediag> [out dir]: unpacks a player's diagnostics report and prints the gist.
// the file comes from someone else, so names are checked before anything gets written

const [file, outArg] = process.argv.slice(2);
if (!file){
    console.log("usage: bun scripts/kutediag.mjs <report.kutediag> [out dir]");
    process.exit(1);
}

const zip = readFileSync(file);
const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (end < 0) throw new Error("not a kutediag file (no zip directory)");
const count = zip.readUInt16LE(end + 10);
let at = zip.readUInt32LE(end + 16);

/** @type {Map<string, Buffer>} */
const entries = new Map();
for (let index = 0; index < count; index++){
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("broken zip directory");
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;

    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressed);
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..")){
        console.warn(`skipped unsafe entry name ${name}`);
        continue;
    }
    entries.set(name, method === 8 ? inflateRawSync(raw) : raw);
}

const out = outArg ?? file.replace(/\.kutediag$/i, "");
for (const [name, data] of entries){
    const target = path.join(out, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
}

/**
 * @param {string} name
 * @return {any}
 */
function json(name){
    const data = entries.get(name);
    return data ? JSON.parse(data.toString("utf8")) : null;
}

const manifest = json("manifest.json");
const kute = json("kute.json");
const system = json("system.json");
const krunker = json("krunker.json");

console.log(`${manifest?.format} v${manifest?.version}, Kute ${manifest?.kute}, created ${manifest?.created}`);
console.log(`unpacked ${entries.size} entries into ${out}: ${[...entries.keys()].join(", ")}`);
if (kute){
    const { version, bundle, cef, portable, frameLimiter, restartOnly } = kute.kute;
    console.log(`\nkute ${version}, bundle ${bundle?.version}, ${cef}, ${portable ? "portable" : "installed"}, limiter ${frameLimiter}`);
    const pending = Object.entries(restartOnly ?? {}).filter(([, state]) => state.running !== state.stored).map(([id]) => id);
    if (pending.length > 0) console.log(`waiting for a restart: ${pending.join(", ")}`);
    console.log(`flags: ${(kute.config.flags ?? []).join(" ")}`);
    /** @type {{key: string, enabled: boolean}[]} */
    const userscripts = kute.config.userscripts ?? [];
    const scripts = userscripts.filter((script) => script.enabled).map((script) => script.key);
    console.log(`userscripts on: ${scripts.join(", ") || "none"}, swaps: ${kute.config.swapper?.count ?? 0}`);
}
if (system){
    const { os, specs, gpuDrivers, live, runningTools } = system;
    // windows 11 still calls itself windows 10 in the registry
    const product = Number(os?.build) >= 22000 ? String(os.product).replace("Windows 10", "Windows 11") : (os?.product ?? os?.kernel);
    console.log(`\n${product} ${os?.displayVersion ?? ""} build ${os?.build ?? specs?.osBuild}.${os?.ubr ?? ""}`);
    console.log(`cpu ${specs?.cpu?.name} (${specs?.cpu?.threads} threads), ram ${specs?.ramMb} MB, ${specs?.laptop ? "laptop" : "desktop"}${specs?.onBattery ? " on battery" : ""}`);
    for (const gpu of gpuDrivers ?? specs?.gpus ?? []) console.log(`gpu ${gpu.name} driver ${gpu.driver ?? "?"}`);
    for (const display of specs?.displays ?? []) console.log(`display ${display.width}x${display.height} @ ${display.hz} Hz${display.hostsWindow ? " (kute)" : ""}`);
    console.log(`hybrid ${specs?.hybrid} (${specs?.hybridSource}), hook ${live?.hook?.state}, present ${live?.present?.fps ?? "-"} fps, limit ${live?.gameFpsLimit}`);
    console.log(`memory ${live?.memory?.availableMb} of ${live?.memory?.totalMb} MB free, HAGS ${os?.hardwareGpuScheduling ?? "-"}, game mode ${os?.gameMode ?? "-"}`);
    if ((runningTools ?? []).length > 0) console.log(`running: ${runningTools.join(", ")}`);
}
if (krunker?.page?.webgl) console.log(`\nwebgl ${krunker.page.webgl.renderer}`);
const events = entries.get("events.txt")?.toString("utf8").split("\n") ?? [];
if (events.length > 0) console.log(`\nlast events:\n${events.slice(-15).join("\n")}`);
if (entries.has("crash_log.txt")) console.log(`\ncrash log:\n${entries.get("crash_log.txt")?.toString("utf8").trim()}`);
