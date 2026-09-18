import { kute } from "../client.js";
import api from "./api.js";

// Who else in this match runs Kute. One WebSocket to the Kute server per page load: the client says once which
// lobby it is in, gets the roster back, and from then on only hears who came and who went. Nothing is polled,
// and the keepalive is the server's ping frame, which the browser answers without running any JavaScript.
//
// A player is only ever sha256(game id + "\n" + name), 16 bytes as hex: the server never sees a name, and the
// hash means nothing outside that match. Not a secret (names can be guessed), it is there so the server holds
// nothing about anybody.
//
// Logged out, the socket carries no join at all (guest names are random), it only counts as a running client.
// The server being gone costs nothing: no health answer, no socket. A socket that keeps failing gives up.

/** seconds until the next try after a lost connection, then it stays quiet until the next page load */
const RECONNECT_S = [2, 4, 8, 16, 30];
/** how often login and lobby get looked at. one id lookup and one call into the game, about a microsecond */
const SYNC_MS = 2000;
const STABLE_MS = 30000;

/**
 * @return {string} The lobby this page is in while an account is logged in, otherwise ""
 */
function currentGame(){
    if (document.getElementById("signedInHeaderBar") === null) return "";
    const id = window.getGameActivity?.()?.id;
    return typeof id === "string" ? id : "";
}

/**
 * @return {string} The name the lists show for this player (the display name, not the account name)
 */
function ownName(){
    const user = window.getGameActivity?.()?.user;
    return typeof user === "string" ? user : "";
}

/**
 * @param {string} game
 * @param {string} name
 * @return {Promise<string>} 16 bytes of sha256(game + "\n" + name) as hex
 */
export async function playerHash(game, name){
    const bytes = new TextEncoder().encode(game + "\n" + name);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class Presence {
    constructor(){
        /** the lobby the roster belongs to, "" while not joined */
        this.game = "";
        /** @type {Set<string>} hashes of the Kute players in this lobby, the own one included */
        this.roster = new Set();
        /** @type {Set<() => void>} called whenever the roster changed */
        this.listeners = new Set();
        /** @type {WebSocket | null} */
        this.socket = null;
        this.failures = 0;
        this.timer = 0;
        /** what the last join said, so the same thing is not sent twice */
        this.joined = "";

        api.available().then((available) => {
            if (available) this.open();
        });
    }

    open(){
        if (api.down) return;
        const socket = new WebSocket(api.base.replace(/^http/, "ws") + "/ws");
        this.socket = socket;

        socket.addEventListener("open", () => {
            // only a connection that lasts counts as working: a server that accepts and closes right away
            // (too many sockets from this address) must not be retried forever
            setTimeout(() => {
                if (this.socket === socket) this.failures = 0;
            }, STABLE_MS);
            // the server counts a client once in its life, and only the client knows whether that happened
            socket.send(JSON.stringify(kute.settings.data.counted === true ? { t: "hi" } : { t: "hi", first: true }));
            this.sync();
            this.timer = setInterval(() => this.sync(), SYNC_MS);
        });
        socket.addEventListener("message", (event) => this.receive(event.data));
        socket.addEventListener("close", () => {
            clearInterval(this.timer);
            this.socket = null;
            this.joined = "";
            this.setRoster("", []);
            const wait = RECONNECT_S[this.failures++];
            if (wait !== undefined) setTimeout(() => this.open(), wait * 1000);
        });
    }

    /**
     * Tells the server when the lobby, the name or the login changed.
     */
    async sync(){
        const game = currentGame();
        const name = game ? ownName() : "";
        const wanted = game && name ? game + "\n" + name : "";
        if (wanted === this.joined) return;
        this.joined = wanted;
        if (!wanted){
            this.send({ t: "leave" });
            this.setRoster("", []);
            return;
        }
        const hash = await playerHash(game, name);
        // the login may have changed again while the hash was being made
        if (this.joined === wanted) this.send({ t: "join", game, hash });
    }

    /**
     * @param {object} message
     */
    send(message){
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    }

    /**
     * @param {unknown} data
     */
    receive(data){
        let message;
        try {
            message = JSON.parse(String(data));
        }
        catch {
            return;
        }
        if (message?.t === "roster" && typeof message.game === "string" && Array.isArray(message.players)){
            // an answer to a join that is not the current one anymore
            if (this.joined.startsWith(message.game + "\n")) this.setRoster(message.game, message.players);
        }
        else if (message?.t === "+" && typeof message.h === "string"){
            this.roster.add(message.h);
            this.changed();
        }
        else if (message?.t === "-" && typeof message.h === "string"){
            this.roster.delete(message.h);
            this.changed();
        }
        else if (message?.t === "counted"){
            kute.settings.data.counted = true;
            window.chrome.webview.postMessage("set-config, counted, true");
        }
    }

    /**
     * @param {string} game
     * @param {unknown[]} players
     */
    setRoster(game, players){
        if (game === this.game && players.length === 0 && this.roster.size === 0) return;
        this.game = game;
        this.roster = new Set(players.filter((player) => typeof player === "string"));
        this.changed();
    }

    changed(){
        for (const listener of this.listeners) listener();
    }
}

const presence = new Presence();
kute.presence = presence;
export default presence;
