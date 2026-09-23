import styles from "../components/spotify.css";
import { kute, ready } from "../client.js";

const OVERLAY_ID = "kuteSpotifyOverlay";

/** @typedef {{title?: string, artist?: string, album?: string, artwork?: string, duration_ms?: number, progress_ms?: number, is_playing?: boolean, playback_status?: string, source?: string}} SpotifyTrack */

class SpotifyOverlay {
    constructor(){
        this.track = null;
        this.status = "disconnected";
        this.overlay = null;
        this.create();
        window.chrome.webview.addEventListener("message", (event) => this.receive(event.data));
        ready.then(() => {
            if (kute.settings.data.spotifyOverlay !== false) this.enable();
            window.chrome.webview.postMessage("spotify-status");
        });
    }

    create(){
        const style = document.createElement("style");
        style.id = "kute_spotifyCSS";
        style.textContent = styles;
        document.head.append(style);

        this.overlay = document.createElement("div");
        this.overlay.id = OVERLAY_ID;
        this.overlay.hidden = true;
        this.overlay.innerHTML = `<img id="kuteSpotifyArtwork" alt=""><div id="kuteSpotifyInfo"><div id="kuteSpotifyTitle"></div><div id="kuteSpotifyArtist"></div><div id="kuteSpotifyProgress"><div></div></div></div>`;
        (document.querySelector("#uiBase") ?? document.body).append(this.overlay);
    }

    /**
    * @param {{spotifyStatus?: string, spotifyDetail?: string, spotify?: SpotifyTrack|null}} data
     */
    receive(data){
        if (typeof data?.spotifyStatus === "string") {
            this.status = data.spotifyStatus;
            if (this.status === "error") {
                this.track = null;
                const detail = typeof data.spotifyDetail === "string" ? data.spotifyDetail : "Erreur inconnue";
                kute.showNotification?.(`Spotify: ${detail.slice(0, 500)}`, false, 8);
            }
        }
        if (Object.hasOwn(data ?? {}, "spotify")) this.track = data.spotify;
        this.render();
    }

    render(){
        if (!this.overlay) return;
        const enabled = kute.settings?.data?.spotifyOverlay !== false;
        this.overlay.hidden = !enabled || !this.track;
        if (!this.track) return;
        const artwork = /** @type {HTMLImageElement} */ (this.overlay.querySelector("#kuteSpotifyArtwork"));
        const title = /** @type {HTMLElement} */ (this.overlay.querySelector("#kuteSpotifyTitle"));
        const artist = /** @type {HTMLElement} */ (this.overlay.querySelector("#kuteSpotifyArtist"));
        const progress = /** @type {HTMLElement} */ (this.overlay.querySelector("#kuteSpotifyProgress > div"));
        this.overlay.dataset.playback = this.track.is_playing ? "playing" : "paused";
        this.overlay.dataset.source = this.track.source ?? "spotify-api";
        artwork.src = this.track.artwork ?? "";
        artwork.alt = this.track.album ?? "";
        title.textContent = this.track.title ?? "";
        artist.textContent = this.track.artist ?? "";
        const duration = Math.max(1, this.track.duration_ms ?? 1);
        progress.style.width = `${Math.min(100, ((this.track.progress_ms ?? 0) / duration) * 100)}%`;
    }

    connect(){
        window.chrome.webview.postMessage("spotify-status");
    }

    /** @param {boolean} enabled */
    toggle(enabled){
        if (!this.overlay) return;
        if (!enabled) this.overlay.hidden = true;
        else this.render();
    }

    enable(){ this.render(); }
}

const spotify = new SpotifyOverlay();
kute.spotify = spotify;
kute.settings.toggleSpotifyOverlay = (enabled) => spotify.toggle(enabled);