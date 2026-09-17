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
 * @property {number} hitches Frames longer than the hitch threshold
 * @property {number} hitchesPerSec
 */

/**
 * Collects frame to frame gaps. Raw samples instead of buckets: at 1500 frames per second the
 * interesting differences are tenths of a millisecond.
 */
export class FrameRecorder {
    /**
     * @param {number} [capacity] Samples to keep, 120000 covers a minute at 2000 frames per second
     */
    constructor(capacity = 120000){
        /** @type {Float32Array} */
        this.samples = new Float32Array(capacity);
        this.count = 0;
        this.last = -1;
        this.first = -1;
    }

    /**
     * Call once per frame with performance.now().
     *
     * @param {number} now
     */
    frame(now){
        if (this.last >= 0 && this.count < this.samples.length) this.samples[this.count++] = now - this.last;
        if (this.first < 0) this.first = now;
        this.last = now;
    }

    /**
     * @param {number} hitchMs
     * @return {FrameStats|null}
     */
    stats(hitchMs){
        if (this.count === 0) return null;
        const sorted = this.samples.slice(0, this.count).sort();
        const seconds = (this.last - this.first) / 1000;
        /**
         * @param {number} p
         * @return {number}
         */
        const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

        let sum = 0;
        let hitches = 0;
        for (const gap of sorted){
            sum += gap;
            if (gap > hitchMs) hitches++;
        }

        return {
            frames: this.count,
            seconds,
            fps: this.count / seconds,
            meanMs: sum / this.count,
            p50: percentile(0.5),
            p95: percentile(0.95),
            p99: percentile(0.99),
            p999: percentile(0.999),
            maxMs: sorted[sorted.length - 1],
            hitches,
            hitchesPerSec: hitches / seconds,
        };
    }
}

/**
 * How long other work waits on the main thread while the frame loop runs. A starved main thread (the old aim
 * freeze) shows up here as delays of tens of milliseconds, long before it shows in the frame times.
 * One probe every 10 ms: an earlier version posted tasks back to back to count them, and that flood of tasks
 * delayed the frame callbacks it was running next to by up to 2 ms. A probe must not load what it measures.
 */
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
        this.timer = setInterval(() => {
            this.sent++;
            this.channel.port2.postMessage(performance.now());
        }, 10);
    }

    /**
     * @return {{sent: number, ran: number, p99: number, max: number}} Delays in ms
     */
    stop(){
        clearInterval(this.timer);
        const sorted = [...this.delays].sort((a, b) => a - b);
        return {
            sent: this.sent,
            ran: sorted.length,
            p99: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0,
            max: sorted[sorted.length - 1] ?? 0,
        };
    }
}
