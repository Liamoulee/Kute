/**
 * Test build only: the page half of the audio cutout log (src/modules/audio_log.rs). The host loads it when
 * "audio-log" is in hostFeatures, which only the test build sends.
 *
 * It reads, it never touches the game's sound: the state of Krunker's audio context, Chromium's own dropout
 * counters for it, and the sound settings the player plays with. Everything goes to the host, which writes the
 * single file in Downloads the tester sends us.
 */
import { kute } from "../client.js";

/** How often the context gets looked at. */
const SAMPLE_MS = 1000;
/** A line even when nothing happened, so a silent log still shows the client was alive. */
const HEARTBEAT_MS = 30000;
/** Krunker keeps its settings in localStorage under this prefix. */
const KRUNKER_SETTING_PREFIX = "kro_setngss_";

class AudioLog {
    constructor(){
        /** @type {HowlerGlobal["ctx"]|null} */
        this.context = null;
        this.lastState = "";
        this.lastDropouts = 0;
        this.lastHeartbeat = 0;
        this.reportedSetup = false;

        this.post({ event: "page loaded", url: location.pathname });
        this.postKrunkerSettings();

        window.chrome.webview.addEventListener("message", (event) => {
            // F9 in the host: write down what the audio looks like at the moment the tester heard the cut
            if (!event.data?.audioMark) return;
            this.post({ event: "state at the mark", ...this.snapshot() });
            // so the tester sees that the F9 arrived
            kute.showNotification?.("Marked in the audio log", false, 2);
        });

        setInterval(() => this.sample(), SAMPLE_MS);
    }

    /**
     * @param {Record<string, unknown>} data
     */
    post(data){
        window.chrome.webview.postMessage(`audio-log ${JSON.stringify(data)}`);
    }

    /**
     * Chromium's counters for the context: how often the audio device ran out of data and how much silence that
     * was. They are what separates "the sound pipeline dropped it" from "the game played nothing".
     *
     * @return {Record<string, number>|null}
     */
    stats(){
        try {
            return this.context?.playbackStats?.toJSON?.() ?? null;
        }
        catch {
            return null;
        }
    }

    /**
     * @return {Record<string, unknown>}
     */
    snapshot(){
        const stats = this.stats();
        const fps = document.getElementById("ingameFPS")?.textContent ?? "";
        return {
            state: this.context?.state ?? "no context",
            dropouts: stats?.underrunEvents ?? 0,
            silentMs: Math.round((stats?.underrunDuration ?? 0) * 1000),
            latencyMs: Math.round((stats?.averageLatency ?? 0) * 1000),
            worstLatencyMs: Math.round((stats?.maximumLatency ?? 0) * 1000),
            outputLatencyMs: Math.round((this.context?.outputLatency ?? 0) * 1000),
            sounds: window.Howler?._howls?.length ?? 0,
            fps,
            hidden: document.hidden,
        };
    }

    /** One line of the timeline per second, but only when something actually changed. */
    sample(){
        const context = window.Howler?.ctx ?? null;
        if (!context) return;
        if (context !== this.context){
            this.context = context;
            this.lastState = "";
            this.lastDropouts = 0;
            this.postSetup();
        }
        if (context.state !== this.lastState){
            if (this.lastState) this.post({ event: "context state", from: this.lastState, to: context.state, ...this.snapshot() });
            this.lastState = context.state;
        }
        const stats = this.stats();
        if (stats && stats.underrunEvents > this.lastDropouts){
            this.post({ event: "DROPOUT", since: stats.underrunEvents - this.lastDropouts, ...this.snapshot() });
            this.lastDropouts = stats.underrunEvents;
        }
        if (performance.now() - this.lastHeartbeat > HEARTBEAT_MS){
            this.lastHeartbeat = performance.now();
            this.post({ event: "still fine", ...this.snapshot() });
        }
    }

    /** The audio setup, once per context. */
    postSetup(){
        const { context } = this;
        if (!context) return;
        this.post({
            section: this.reportedSetup ? "the game made a new audio context" : "the game's audio",
            data: {
                sampleRate: context.sampleRate,
                baseLatencyMs: Math.round(context.baseLatency * 1000),
                outputLatencyMs: Math.round(context.outputLatency * 1000),
                state: context.state,
                webAudio: window.Howler?.usingWebAudio ?? null,
                volume: window.Howler?.volume?.() ?? null,
                dropoutStatsAvailable: this.stats() !== null,
            },
        });
        this.reportedSetup = true;
    }

    /** The sound settings of the game, the ones that decide what gets played at all. */
    postKrunkerSettings(){
        /** @type {Record<string, string>} */
        const data = {};
        for (let index = 0; index < localStorage.length; index++){
            const key = localStorage.key(index) ?? "";
            if (!key.startsWith(KRUNKER_SETTING_PREFIX)) continue;
            if (!/sound|volume|audio|voice|mic|ambient|dialogue/i.test(key)) continue;
            data[key.slice(KRUNKER_SETTING_PREFIX.length)] = String(localStorage.getItem(key)).slice(0, 100);
        }
        this.post({ section: "krunker sound settings", data });
    }
}

export default new AudioLog();
