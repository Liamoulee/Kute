/**
 * @typedef {object} FrameStats
 * @property {number} frames
 * @property {number} seconds
 * @property {number} fps
 * @property {number} meanMs
 * @property {number} p50
 * @property {number} p95
 * @property {number} p99
 * @property {number} p999
 * @property {number} maxMs
 * @property {number} hitches frames over the hitch threshold (4x the median, at least one refresh)
 * @property {number} hitchesPerSec
 * @property {number} stallMs ms per second lost in hitches, a 2 s freeze among fast frames shows here and not in p99
 */

// raw frame gaps, no buckets: at 1500 fps the differences are tenths of a ms
export class FrameRecorder {
    /**
     * @param {number} [capacity] 120000 = a minute at 2000 fps
     */
    constructor(capacity = 120000){
        /** @type {Float32Array} */
        this.samples = new Float32Array(capacity);
        this.count = 0;
        this.stored = 0;
        this.last = -1;
        this.first = -1;
    }

    /**
     * @param {number} now
     */
    frame(now){
        if (this.last >= 0){
            // keep counting past capacity, fps is over the whole duration
            this.count++;
            if (this.stored < this.samples.length) this.samples[this.stored++] = now - this.last;
        }
        if (this.first < 0) this.first = now;
        this.last = now;
    }

    /**
     * @param {number} refreshMs one refresh of the display: a frame under it is never a hitch, however fast the rest runs
     * @return {FrameStats|null}
     */
    stats(refreshMs){
        if (this.stored === 0) return null;
        const sorted = this.samples.slice(0, this.stored).sort();
        const seconds = (this.last - this.first) / 1000;
        /**
         * @param {number} p
         * @return {number}
         */
        const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        const p50 = percentile(0.5);
        // relative to the PC's own pace, so a slow PC's normal frames are not hitches
        const hitchMs = Math.max(4 * p50, refreshMs);

        let sum = 0;
        let hitches = 0;
        let stalled = 0;
        for (const gap of sorted){
            sum += gap;
            if (gap > hitchMs){
                hitches++;
                stalled += gap - p50;
            }
        }
        // over the stored gaps only, not the whole duration
        const storedSeconds = Math.max(0.001, sum / 1000);

        return {
            frames: this.count,
            seconds,
            fps: this.count / seconds,
            meanMs: sum / this.stored,
            p50,
            p95: percentile(0.95),
            p99: percentile(0.99),
            p999: percentile(0.999),
            maxMs: sorted[sorted.length - 1],
            hitches,
            hitchesPerSec: hitches / storedSeconds,
            stallMs: stalled / storedSeconds,
        };
    }
}

// how long pointer moves waited before the page got them, only while the game holds the pointer.
// pointermove on purpose: a pointerrawupdate listener switches chromium to low latency input and changes what it measures
export class InputProbe {
    constructor(){
        this.waits = new Float32Array(1 << 14);
        this.events = 0;
        this.packets = 0;
        /** @param {PointerEvent} event */
        this.onMove = (event) => {
            if (document.pointerLockElement === null) return;
            // the oldest packet in the event waited longest
            const coalesced = event.getCoalescedEvents();
            const oldest = coalesced.length > 0 ? coalesced[0].timeStamp : event.timeStamp;
            this.waits[this.events % this.waits.length] = performance.now() - oldest;
            this.events++;
            this.packets += Math.max(1, coalesced.length);
        };
    }

    start(){
        this.events = 0;
        this.packets = 0;
        window.addEventListener("pointermove", this.onMove, { capture: true, passive: true });
    }

    /**
     * @return {{events: number, packets: number, p99: number|null, max: number|null}} waits in ms, null without events
     */
    stop(){
        window.removeEventListener("pointermove", this.onMove, true);
        const stored = Math.min(this.events, this.waits.length);
        const sorted = this.waits.slice(0, stored).sort();
        return {
            events: this.events,
            packets: this.packets,
            p99: stored > 0 ? sorted[Math.min(stored - 1, Math.floor(stored * 0.99))] : null,
            max: stored > 0 ? sorted[stored - 1] : null,
        };
    }
}

// main thread task delay while the loop runs, one probe per 10 ms so it doesn't load what it measures
export class TaskProbe {
    constructor(){
        /** @type {number[]} */
        this.delays = [];
        this.timer = 0;
        this.sent = 0;
        this.channel = new MessageChannel();
        this.channel.port1.onmessage = (event) => {
            this.delays.push(performance.now() - event.data);
        };
    }

    start(){
        this.delays = [];
        this.sent = 0;
        let due = performance.now() + 10;
        this.timer = setInterval(() => {
            this.sent++;
            // measure from when the timer was due, a busy thread delays the timer itself too
            const now = performance.now();
            this.channel.port2.postMessage(Math.min(now, due));
            due = now + 10;
        }, 10);
    }

    /**
     * @return {{sent: number, ran: number, p99: number|null, max: number|null}} delays in ms, null when no probe ran
     */
    stop(){
        clearInterval(this.timer);
        const sorted = [...this.delays].sort((a, b) => a - b);
        return {
            sent: this.sent,
            ran: sorted.length,
            p99: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : null,
            max: sorted.length ? sorted[sorted.length - 1] : null,
        };
    }
}
