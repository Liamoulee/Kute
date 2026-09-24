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
 * @property {number} hitches frames over the hitch threshold
 * @property {number} hitchesPerSec
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
     * @param {number} hitchMs
     * @return {FrameStats|null}
     */
    stats(hitchMs){
        if (this.stored === 0) return null;
        const sorted = this.samples.slice(0, this.stored).sort();
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
            meanMs: sum / this.stored,
            p50: percentile(0.5),
            p95: percentile(0.95),
            p99: percentile(0.99),
            p999: percentile(0.999),
            maxMs: sorted[sorted.length - 1],
            hitches,
            // over the stored gaps only, not the whole duration
            hitchesPerSec: hitches / Math.max(0.001, sum / 1000),
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
