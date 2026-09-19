// Reads a flight recorder capture (src/modules/perf_recorder.rs) and says what happened in its long frames.
// usage: bun tools/analyze-capture.mjs [capture dir] [--frames N]
// without a dir it takes the newest one in Documents\kute\captures. The trace can be hundreds of MB, so it is streamed
// event by event instead of parsed in one piece.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const framesArg = args.indexOf("--frames");
const frameCount = framesArg >= 0 ? Number(args[framesArg + 1]) : 5;
const capturesRoot = path.join(os.homedir(), "Documents", "kute", "captures");
const dir = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--frames")
    ?? path.join(capturesRoot, fs.readdirSync(capturesRoot).filter((name) => fs.existsSync(path.join(capturesRoot, name, "trace.json"))).sort().at(-1) ?? "");

// the only events whose args are kept, everything else keeps timing and names only
const KEEP_ARGS = new Set(["thread_name", "process_name", "TimeStamp", "FunctionCall", "Profile", "ProfileChunk", "EvaluateScript", "ResourceSendRequest"]);

/** @type {any[]} */
const events = [];
/** @type {Map<string, any[]>} open B events per thread */
const open = new Map();

/**
 * @param {any} event
 */
function keep(event){
    const { ph, name, pid, tid, ts, dur } = event;
    if (ph === "B"){
        const key = pid + ":" + tid;
        if (!open.has(key)) open.set(key, []);
        open.get(key)?.push(event);
        return;
    }
    if (ph === "E"){
        const begin = open.get(pid + ":" + tid)?.pop();
        if (begin) events.push({ ph: "X", name: begin.name, cat: begin.cat, pid, tid, ts: begin.ts, dur: ts - begin.ts });
        return;
    }
    if (ph !== "X" && ph !== "M" && ph !== "I" && ph !== "i" && ph !== "P" && ph !== "R" && ph !== "n") return;
    events.push({ ph, name, cat: event.cat, pid, tid, ts, dur, id: event.id, args: KEEP_ARGS.has(name) ? event.args : undefined });
}

// one object at a time out of {"traceEvents":[ {...}, {...} ]}
async function stream(file){
    const decoder = new TextDecoder();
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;
    let carry = new Uint8Array(0);
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 16 << 20 })){
        const bytes = new Uint8Array(carry.length + chunk.length);
        bytes.set(carry);
        bytes.set(chunk, carry.length);
        let cut = 0;
        // the carried bytes were scanned already, only their object start matters
        for (let i = carry.length; i < bytes.length; i++){
            const b = bytes[i];
            if (inString){
                if (escaped) escaped = false;
                else if (b === 92) escaped = true;
                else if (b === 34) inString = false;
                continue;
            }
            if (b === 34) inString = true;
            else if (b === 123){
                // depth 1 is the wrapper object, the events are at depth 2
                if (depth === 1) start = i;
                depth++;
            }
            else if (b === 125){
                depth--;
                if (depth === 1 && start >= 0){
                    keep(JSON.parse(decoder.decode(bytes.subarray(start, i + 1))));
                    start = -1;
                    cut = i + 1;
                }
            }
        }
        carry = bytes.slice(start >= 0 ? start : cut);
        if (start >= 0) start = 0;
    }
}

const started = performance.now();
const traceFile = path.join(dir, "trace.json");
const traceMb = fs.statSync(traceFile).size / 1e6;
await stream(traceFile);
const context = fs.existsSync(path.join(dir, "context.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "context.json"), "utf8")) : null;

// names
const processNames = new Map();
const threadNames = new Map();
for (const e of events){
    if (e.ph !== "M") continue;
    if (e.name === "process_name") processNames.set(e.pid, e.args?.name);
    if (e.name === "thread_name") threadNames.set(e.pid + ":" + e.tid, e.args?.name);
}
const threadLabel = (pid, tid) => `${processNames.get(pid) ?? "pid " + pid} / ${threadNames.get(pid + ":" + tid) ?? "tid " + tid}`;

// the F8 mark and the game's main thread
const mark = events.find((e) => e.name === "TimeStamp" && e.args?.data?.message === "kute-f8");
const timed = events.filter((e) => e.ph === "X" && typeof e.ts === "number");
const traceStart = timed.reduce((min, e) => Math.min(min, e.ts), Infinity);
const traceEnd = timed.reduce((max, e) => Math.max(max, e.ts + (e.dur ?? 0)), 0);
const f8 = mark?.ts ?? traceEnd - 5e6;
const mainKey = mark ? mark.pid + ":" + mark.tid
    : [...threadNames].filter(([, name]) => name === "CrRendererMain").map(([key]) => key)
        .sort((a, b) => timed.filter((e) => e.pid + ":" + e.tid === b).length - timed.filter((e) => e.pid + ":" + e.tid === a).length)[0];
const [mainPid] = (mainKey ?? "0:0").split(":").map(Number);

// frames: the starts of the game's requestAnimationFrame callbacks
const rafs = timed.filter((e) => e.pid + ":" + e.tid === mainKey && e.name === "FireAnimationFrame").map((e) => e.ts).sort((a, b) => a - b);
const gaps = rafs.slice(1).map((ts, i) => ({ from: rafs[i], to: ts, ms: (ts - rafs[i]) / 1000 }));
const sorted = gaps.map((g) => g.ms).sort((a, b) => a - b);
const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
const median = pct(0.5);
const at = (ts) => ((ts - f8) / 1e6).toFixed(2).padStart(6) + " s";

console.log(`capture ${path.basename(dir)}: ${traceMb.toFixed(0)} MB, ${events.length.toLocaleString()} events, read in ${((performance.now() - started) / 1000).toFixed(1)} s`);
console.log(`covers ${((traceEnd - traceStart) / 1e6).toFixed(1)} s, F8 at ${mark ? "the page mark" : "UNKNOWN (no kute-f8 mark, assumed 5 s before the end)"} = ${at(f8)}`);
if (context?.page){
    const p = context.page;
    console.log(`page: ${p.activity ? `${p.activity.mode} on ${p.activity.map}${p.activity.custom ? " (private)" : ""}, ` : ""}${p.players} players, pointer ${p.pointerLocked ? "locked" : "free"}, canvas ${p.canvas?.width}x${p.canvas?.height}, heap ${p.jsHeapMb} MB`);
}
if (context?.settings){
    const s = context.settings;
    console.log(`settings: fps limit ${s.gameFpsLimit ?? 0}, hook ${s.hardFlip ?? "default"}, angle ${s.angleBackend ?? "default"}, throttle ${s.throttle ?? 1}, priority ${s.webviewPriority ?? "Normal"}`);
}
console.log(`\nframes (game rAF on ${threadLabel(...mainKey.split(":").map(Number))}): ${rafs.length}, median ${median.toFixed(2)} ms, p99 ${pct(0.99).toFixed(2)}, p99.9 ${pct(0.999).toFixed(2)}, max ${pct(1).toFixed(1)} ms`);

const long = gaps.filter((g) => g.ms >= Math.max(25, median * 4)).sort((a, b) => b.ms - a.ms);
console.log(`${long.length} frames over ${Math.max(25, median * 4).toFixed(0)} ms. longest:`);
for (const g of long.slice(0, 15)) console.log(`  ${g.ms.toFixed(1).padStart(7)} ms at ${at(g.from)} from F8`);

// sampled JS stacks (disabled-by-default-v8.cpu_profiler), per profile id of the main process
// sample times are deltas chained across a profile's chunks. the ring overwrites the "Profile" event with the start
// time and the early chunks, so the chain gets one offset: the median gap between a chunk's timestamp (written right
// after its last sample) and the chained time of that sample. functions first seen in a lost chunk show as "(lost)"
/** @type {Map<string, {nodes: Map<number, any>, samples: {ts: number, node: number}[], chained: number, start: number|null, anchors: number[], tid: number|null}>} */
const profiles = new Map();
const chunks = events.filter((e) => e.pid === mainPid && (e.name === "ProfileChunk" || e.name === "Profile")).sort((a, b) => a.ts - b.ts);
for (const e of chunks){
    const key = String(e.id);
    if (!profiles.has(key)) profiles.set(key, { nodes: new Map(), samples: [], chained: 0, start: null, anchors: [], tid: null });
    const profile = profiles.get(key);
    const data = e.args?.data;
    if (!profile || !data) continue;
    if (e.name === "Profile"){
        // emitted on the profiled thread: the main thread, a worker or the service worker each have their own
        profile.start = data.startTime ?? e.ts;
        profile.tid = e.tid;
        continue;
    }
    for (const node of data.cpuProfile?.nodes ?? []) profile.nodes.set(node.id, node);
    const deltas = data.timeDeltas ?? [];
    (data.cpuProfile?.samples ?? []).forEach((node, i) => {
        profile.chained += deltas[i] ?? 0;
        profile.samples.push({ ts: profile.chained, node });
    });
    profile.anchors.push(e.ts - profile.chained);
}
for (const profile of profiles.values()){
    const anchors = profile.anchors.sort((a, b) => a - b);
    const offset = profile.start ?? anchors[Math.floor(anchors.length / 2)] ?? 0;
    for (const sample of profile.samples) sample.ts += offset;
}
const frameName = (node) => {
    if (!node) return "(lost)";
    const f = node.callFrame ?? {};
    const file = (f.url ?? "").split("/").pop().split("?")[0];
    return `${f.functionName || "(anonymous)"}${file ? ` ${file}:${(f.lineNumber ?? 0) + 1}` : ""}`;
};

/**
 * @param {any} profile
 * @param {number} from
 * @param {number} to
 */
function jsIn(profile, from, to){
    const self = new Map();
    const inclusive = new Map();
    let total = 0;
    let previous = null;
    for (const sample of profile.samples){
        if (previous && previous.ts >= from && previous.ts < to){
            const delta = sample.ts - previous.ts;
            total += delta;
            const own = frameName(profile.nodes.get(previous.node));
            self.set(own, (self.get(own) ?? 0) + delta);
            const seen = new Set();
            for (let id = previous.node; id !== undefined; id = profile.nodes.get(id)?.parent){
                const name = frameName(profile.nodes.get(id));
                if (seen.has(name)) continue;
                seen.add(name);
                inclusive.set(name, (inclusive.get(name) ?? 0) + delta);
            }
        }
        previous = sample;
    }
    const top = (map) => [...map].sort((a, b) => b[1] - a[1]).filter(([name]) => !/^\((root|program|idle)\)/.test(name)).slice(0, 12);
    return { total, self: top(self), inclusive: top(inclusive) };
}
// sample parents come from the chunks' parent field, fill them in when only children lists were sent
for (const profile of profiles.values()){
    for (const node of profile.nodes.values()){
        for (const child of node.children ?? []){
            const c = profile.nodes.get(child);
            if (c && c.parent === undefined) c.parent = node.id;
        }
    }
}

// everything every thread did during one long frame, as a tree of the events of 1 ms and more
const byThread = new Map();
for (const e of timed){
    const key = e.pid + ":" + e.tid;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(e);
}
for (const list of byThread.values()) list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);

function describe(g){
    const { from, to } = g;
    console.log(`\n=== ${g.ms.toFixed(1)} ms frame at ${at(from)} from F8 (usual frame ${median.toFixed(2)} ms) ===`);
    const threads = [];
    for (const [key, list] of byThread){
        const inside = list.filter((e) => e.ts < to && e.ts + (e.dur ?? 0) > from);
        if (!inside.length) continue;
        // busy time: the union of the outermost events
        let busy = 0;
        let reach = -Infinity;
        for (const e of inside){
            const end = Math.min(e.ts + e.dur, to);
            if (end <= reach) continue;
            busy += end - Math.max(e.ts, from, reach);
            reach = end;
        }
        threads.push({ key, inside, busy });
    }
    threads.sort((a, b) => b.busy - a.busy);
    for (const { key, inside, busy } of threads.filter((t) => t.busy >= 2000).slice(0, 8)){
        const [pid, tid] = key.split(":").map(Number);
        console.log(`\n  ${threadLabel(pid, tid)}: busy ${(busy / 1000).toFixed(1)} ms of ${g.ms.toFixed(1)}`);
        const stack = [];
        let lines = 0;
        for (const e of inside){
            while (stack.length && stack.at(-1) <= e.ts) stack.pop();
            const depth = stack.length;
            stack.push(e.ts + e.dur);
            if (e.dur < 1000 || depth > 6 || lines >= 30) continue;
            const detail = e.args?.data?.functionName || e.args?.data?.url?.split("/").pop() || "";
            console.log(`    ${"  ".repeat(depth)}${(e.dur / 1000).toFixed(1).padStart(6)} ms  ${e.name}${detail ? " (" + detail + ")" : ""}${e.ts < from ? "  [started earlier]" : ""}`);
            lines++;
        }
    }
    const mainTid = Number(mainKey.split(":")[1]);
    const ordered = [...profiles.values()].sort((a, b) => Number(b.tid === mainTid) - Number(a.tid === mainTid));
    for (const profile of ordered){
        const js = jsIn(profile, from, to);
        // a worker that only idled has nothing but (idle) samples, which the top lists leave out
        if (js.total < 1000 || !js.self.length) continue;
        const thread = profile.tid === null ? "unknown thread (start lost)" : threadLabel(mainPid, profile.tid);
        console.log(`\n  JS samples on ${thread}: ${(js.total / 1000).toFixed(1)} ms sampled`);
        console.log("    self:      " + js.self.map(([name, us]) => `${(us / 1000).toFixed(1)} ${name}`).join(" | "));
        console.log("    inclusive: " + js.inclusive.map(([name, us]) => `${(us / 1000).toFixed(1)} ${name}`).join(" | "));
    }
}

// the long frames closest before F8 are what the player reacted to, then the worst of the rest
const reacted = long.filter((g) => g.from <= f8 && g.from >= f8 - 10e6).sort((a, b) => b.from - a.from);
const chosen = [...new Set([...reacted.slice(0, Math.ceil(frameCount / 2)), ...long])].slice(0, frameCount);
for (const g of chosen) describe(g);
if (!chosen.length) console.log("\nno long frames in this capture");
