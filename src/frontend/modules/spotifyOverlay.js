import styles from "../components/spotifyOverlay.css";
import markup from "../components/spotifyOverlay.html";
import { kute } from "../client.js";

/**
 * What Spotify is playing, in the HUD. The host reads it from the Windows media session (no account, no network)
 * and only posts when the song, play state or position jumps, the page moves the progress bar in between.
 */

// a running css/waapi animation, even transform only, cost 10 % fps uncapped in a match. one step a second is a pixel
const PROGRESS_STEP_MS = 1000;

/**
 * @typedef {object} SpotifyState
 * @property {boolean} playing
 * @property {number} position ms
 * @property {number} duration ms
 */

/**
 * @typedef {SpotifyState & {title: string, artist: string, album: string, artwork: string|null}} SpotifySong
 */

class SpotifyOverlay {
    constructor(){
        /** @type {HTMLElement|null} */
        this.overlay = null;
        /** @type {SpotifyState & {at: number}|null} */
        this.playback = null;
        /** @type {number|null} */
        this.timer = null;
        /** @type {string|null} */
        this.artwork = null;
        /** @param {MessageEvent} event */
        this.listener = (event) => {
            const { data } = event;
            if (typeof data !== "object" || data === null) return;
            if ("spotify" in data) this.song(data.spotify);
            else if ("spotifyState" in data) this.state(data.spotifyState);
        };

        kute.settings.toggleSpotifyOverlay = (enabled) => this.toggle(enabled);
        this.toggle(!!kute.settings.data.spotifyOverlay);
    }

    /** @param {boolean} enabled */
    toggle(enabled){
        if (!enabled){
            window.chrome.webview.removeEventListener("message", this.listener);
            window.chrome.webview.postMessage("spotify-stop");
            this.stopProgress();
            this.overlay?.remove();
            this.overlay = null;
            this.artwork = null;
            document.querySelector("#kuteSpotifyOverlayCSS")?.remove();
            return;
        }
        if (this.overlay) return;
        const style = document.createElement("style");
        style.id = "kuteSpotifyOverlayCSS";
        style.textContent = styles;
        document.head.append(style);

        this.overlay = document.createElement("div");
        this.overlay.id = "kuteSpotifyOverlay";
        this.overlay.hidden = true;
        this.overlay.innerHTML = markup;
        (document.querySelector("#uiBase") ?? document.body).append(this.overlay);

        window.chrome.webview.addEventListener("message", this.listener);
        // the host answers with the current song, also when it was already watching for an earlier page
        window.chrome.webview.postMessage("spotify-start");
    }

    /** @param {SpotifySong|null} song */
    song(song){
        if (!this.overlay) return;
        this.overlay.hidden = !song;
        if (!song) return;
        const artwork = /** @type {HTMLImageElement} */ (this.overlay.querySelector("#kuteSpotifyArtwork"));
        // the artwork is a ~200 KB data url, only a new song replaces it
        if (song.artwork !== this.artwork){
            this.artwork = song.artwork;
            artwork.src = song.artwork ?? "";
        }
        artwork.alt = song.album;
        /** @type {HTMLElement} */ (this.overlay.querySelector("#kuteSpotifyTitle")).textContent = song.title;
        /** @type {HTMLElement} */ (this.overlay.querySelector("#kuteSpotifyArtist")).textContent = song.artist;
        this.state(song);
    }

    /** @param {SpotifyState} state */
    state({ playing, position, duration }){
        if (!this.overlay) return;
        this.overlay.classList.toggle("paused", !playing);
        this.playback = { playing, position, duration, at: performance.now() };
        this.drawProgress();
        if (playing && this.timer === null) this.timer = window.setInterval(() => this.drawProgress(), PROGRESS_STEP_MS);
        else if (!playing) this.stopProgress();
    }

    drawProgress(){
        const bar = /** @type {HTMLElement|null} */ (this.overlay?.querySelector("#kuteSpotifyProgress > div") ?? null);
        if (!bar || !this.playback) return;
        const { playing, position, duration, at } = this.playback;
        const now = position + (playing ? performance.now() - at : 0);
        bar.style.transform = `scaleX(${duration > 0 ? Math.min(1, now / duration).toFixed(4) : 0})`;
    }

    stopProgress(){
        if (this.timer !== null) window.clearInterval(this.timer);
        this.timer = null;
    }
}

export default new SpotifyOverlay();
