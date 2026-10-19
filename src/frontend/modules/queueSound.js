import { kute } from "../client.js";

/**
 * The match found sound of the queue window (externalQueue.js): its volume and the player's own sound files from
 * Documents\kute\sounds.
 */

// value of queueSoundFile for the sound that ships with kute
const KUTE_SOUND = "";
// percent. full volume was far louder than the game, which plays its own match found pop at 0.15
const DEFAULT_VOLUME = 40;
const REPLY_TIMEOUT = 5000;

/**
 * @return {boolean}
 */
const hostSupportsSounds = () => kute.hostFeatures?.includes("custom-sounds") ?? false;

/**
 * @return {number} 0 to 1, read when the sound plays so the slider applies to an open queue window
 */
export const volume = () => Math.min(1, Math.max(0, Number(kute.settings.data.queueSoundVolume ?? DEFAULT_VOLUME) / 100 || 0));

/**
 * @template T
 * @param {string} message
 * @param {(data: any) => T|undefined} pick Returns the reply once it is the one asked for
 * @return {Promise<T|null>} null when the host does not answer
 */
function ask(message, pick){
    return new Promise((resolve) => {
        /** @type {number} */
        let timer = 0;
        /**
         * @param {MessageEvent} event
         */
        const listener = (event) => {
            const value = pick(event.data);
            if (value === undefined) return;
            clearTimeout(timer);
            window.chrome.webview.removeEventListener("message", listener);
            resolve(value);
        };
        timer = setTimeout(() => {
            window.chrome.webview.removeEventListener("message", listener);
            resolve(null);
        }, REPLY_TIMEOUT);
        window.chrome.webview.addEventListener("message", listener);
        window.chrome.webview.postMessage(message);
    });
}

/**
 * @return {Promise<string>} kute's sound as base64, lazy so it stays out of the bundle's startup
 */
export const kuteSound = () => import("../components/queue/match-found.ogg").then((module) => module.default);

/**
 * @param {string} name
 * @return {Promise<{data?: string, error?: string}|null>}
 */
const readSound = (name) => ask(`sound-get ${JSON.stringify({ name })}`, (data) => (data?.sound?.name === name ? data.sound : undefined));

/**
 * @return {Promise<string>} the chosen sound as base64, kute's when the file is gone or unreadable
 */
export async function chosenSound(){
    const name = String(kute.settings.data.queueSoundFile ?? KUTE_SOUND);
    if (name !== KUTE_SOUND && hostSupportsSounds()){
        const sound = await readSound(name);
        if (sound?.data) return sound.data;
    }
    return kuteSound();
}

class QueueSound {
    constructor(){
        /** @type {AudioContext|null} */
        this.context = null;
        /** @type {AudioBufferSourceNode|null} */
        this.playing = null;
        /** @type {GainNode|null} */
        this.gain = null;
        kute.queueSound = { showOptions: () => this.showOptions() };
    }

    /**
     * @param {string} base64
     */
    async play(base64){
        this.stop();
        this.context ??= new AudioContext();
        if (this.context.state === "suspended") await this.context.resume();
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const buffer = await this.context.decodeAudioData(bytes.buffer);
        const gain = this.context.createGain();
        gain.gain.value = volume();
        gain.connect(this.context.destination);
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.onended = () => {
            if (this.playing === source) this.playing = null;
            source.disconnect();
            gain.disconnect();
        };
        source.start();
        this.playing = source;
        this.gain = gain;
    }

    stop(){
        this.playing?.stop();
        this.playing = null;
    }

    async showOptions(){
        const html = await import("../components/queueSoundOptions.html");
        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = html.default;

        /**
         * @param {string} id
         * @return {HTMLElement}
         */
        const element = (id) => /** @type {HTMLElement} */ (shadow.querySelector(`#${id}`));
        const select = /** @type {HTMLSelectElement} */ (element("qsSound"));
        const slider = /** @type {HTMLInputElement} */ (element("qsVolume"));
        const savedVolume = Math.round(volume() * 100);
        const error = element("qsError");
        let chosen = String(kute.settings.data.queueSoundFile ?? KUTE_SOUND);

        /**
         * @param {string} text
         */
        const showError = (text) => {
            error.textContent = text;
            error.hidden = !text;
        };

        const fillSounds = async() => {
            const supported = hostSupportsSounds();
            const files = supported ? await ask("sound-list", (data) => (Array.isArray(data?.sounds) ? /** @type {string[]} */ (data.sounds) : undefined)) ?? [] : [];
            const options = [new Option("Kute's sound", KUTE_SOUND)];
            if (files.length){
                const group = document.createElement("optgroup");
                group.label = "Your sounds";
                group.append(...files.map((name) => new Option(name, name)));
                options.push(/** @type {any} */ (group));
            }
            // a chosen file that is gone stays listed, so opening this never changes the setting by itself
            if (chosen !== KUTE_SOUND && !files.includes(chosen)) options.push(new Option(`${chosen} (missing)`, chosen));
            select.replaceChildren(...options);
            select.value = chosen;
            element("qsOpenFolder").hidden = !supported;
            element("qsRefresh").hidden = !supported;
            let hint = "Put MP3, OGG, WAV or FLAC files into Documents\\kute\\sounds";
            if (!supported) hint = "Your own sounds need a newer Kute. Update Kute to use them.";
            else if (files.length === 0) hint = "Add your own: put MP3, OGG, WAV or FLAC files into Documents\\kute\\sounds, then press Refresh";
            element("qsFileHint").textContent = hint;
        };

        const showVolume = () => {
            element("qsVolumeValue").textContent = `${slider.value} %`;
        };
        slider.value = String(savedVolume);
        showVolume();
        // live, so Play and an open queue window use it right away. stored on close
        slider.oninput = () => {
            kute.settings.data.queueSoundVolume = Number(slider.value);
            showVolume();
            if (this.playing && this.gain) this.gain.gain.value = volume();
        };

        select.onchange = () => {
            chosen = select.value;
            showError("");
        };
        element("qsPlay").onclick = async() => {
            showError("");
            if (volume() === 0) showError("The volume is at 0.");
            try {
                if (chosen === KUTE_SOUND){
                    await this.play(await kuteSound());
                    return;
                }
                const sound = await readSound(chosen);
                if (!sound?.data){
                    showError(sound?.error ?? "Kute did not answer.");
                    return;
                }
                await this.play(sound.data);
            }
            catch {
                showError("This file cannot be played. Try MP3, OGG or WAV.");
            }
        };
        element("qsOpenFolder").onclick = () => window.chrome.webview.postMessage("open, sounds");
        element("qsRefresh").onclick = () => fillSounds();

        const controller = new AbortController();
        const close = () => {
            controller.abort();
            this.stop();
            overlay.remove();
            if (Number(slider.value) !== savedVolume) window.chrome.webview.postMessage(`set-config-json queueSoundVolume ${Number(slider.value)}`);
            if (chosen === String(kute.settings.data.queueSoundFile ?? KUTE_SOUND)) return;
            kute.settings.data.queueSoundFile = chosen;
            window.chrome.webview.postMessage(`set-config-json queueSoundFile ${JSON.stringify(chosen)}`);
        };
        element("qsDone").onclick = close;
        overlay.addEventListener("mousedown", (event) => {
            if (event.target === overlay) close();
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                close();
            },
            { signal: controller.signal, capture: true },
        );

        document.body.append(overlay);
        await fillSounds();
    }
}

export default new QueueSound();
