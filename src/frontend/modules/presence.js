import { kute } from "../client.js";
import api from "./api.js";

/** reconnect delays, then quiet until the next page load */
const RECONNECT_S = [2, 4, 8, 16, 30];
/** login/lobby check interval, costs about a microsecond */
const SYNC_MS = 2000;
const STABLE_MS = 30000;
/** join goes out without a dev proof after this */
const PROOF_MS = 1000;

/**
 * @return {string} current lobby while logged in, else ""
 */
function currentGame(){
    if (document.getElementById("signedInHeaderBar") === null) return "";
    const id = window.getGameActivity?.()?.id;
    return typeof id === "string" ? id : "";
}

/**
 * @return {string} display name (what the lists show), not the account name
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

/**
 * asks the host to prove this pc has a dev token. the token never enters the page
 *
 * @param {string} nonce
 * @param {string} game
 * @param {string} hash
 * @return {Promise<{user: string, proof: string} | null>}
 */
function devProof(nonce, game, hash){
    return new Promise((resolve) => {
        let timer = 0;
        /**
         * @param {MessageEvent} event
         */
        const listener = (event) => {
            const reply = event?.data?.devProof;
            // someone else's request or an older connection
            if (reply?.nonce !== nonce) return;
            clearTimeout(timer);
            window.chrome.webview.removeEventListener("message", listener);
            resolve(typeof reply.user === "string" && typeof reply.proof === "string" ? { user: reply.user, proof: reply.proof } : null);
        };
        // old exes never answer
        timer = setTimeout(() => {
            window.chrome.webview.removeEventListener("message", listener);
            resolve(null);
        }, PROOF_MS);
        window.chrome.webview.addEventListener("message", listener);
        window.chrome.webview.postMessage(`dev-proof, ${nonce}, ${game}, ${hash}`);
    });
}

class Presence {
    constructor(){
        this.game = "";
        /** @type {Set<string>} kute player hashes in this lobby, own one included */
        this.roster = new Set();
        /** @type {Map<string, string>} dev hash -> clan tag their row must show */
        this.devs = new Map();
        this.nonce = "";
        /** @type {Set<() => void>} */
        this.listeners = new Set();
        /** @type {WebSocket | null} */
        this.socket = null;
        this.failures = 0;
        this.timer = 0;
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
            // only a lasting connection resets the backoff, a server that closes right away (too many sockets) must not be retried forever
            setTimeout(() => {
                if (this.socket === socket) this.failures = 0;
            }, STABLE_MS);
            // server counts a client once ever, only the client knows if that happened
            socket.send(JSON.stringify(kute.settings.data.counted === true ? { t: "hi" } : { t: "hi", first: true }));
            this.sync();
            this.timer = setInterval(() => this.sync(), SYNC_MS);
        });
        socket.addEventListener("message", (event) => this.receive(event.data));
        socket.addEventListener("close", () => {
            clearInterval(this.timer);
            this.socket = null;
            this.joined = "";
            this.nonce = "";
            this.setRoster("", []);
            const wait = RECONNECT_S[this.failures++];
            if (wait !== undefined) setTimeout(() => this.open(), wait * 1000);
        });
    }

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
        // login may have changed while hashing
        if (this.joined !== wanted) return;
        const dev = kute.dev === true && this.nonce ? await devProof(this.nonce, game, hash) : null;
        if (this.joined !== wanted) return;
        this.send(dev ? { t: "join", game, hash, dev } : { t: "join", game, hash });
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
        if (message?.t === "hello" && typeof message.nonce === "string"){
            this.nonce = message.nonce;
        }
        else if (message?.t === "roster" && typeof message.game === "string" && Array.isArray(message.players)){
            // skip answers to an outdated join
            if (this.joined.startsWith(message.game + "\n")) this.setRoster(message.game, message.players);
        }
        else if (message?.t === "+" && typeof message.h === "string"){
            // upsert, the dev flag can change while the hash stays
            this.remember(message.h, message.d === 1 ? message.c : undefined);
            this.changed();
        }
        else if (message?.t === "-" && typeof message.h === "string"){
            this.roster.delete(message.h);
            this.devs.delete(message.h);
            this.changed();
        }
        else if (message?.t === "counted"){
            kute.settings.data.counted = true;
            window.chrome.webview.postMessage("set-config, counted, true");
        }
    }

    /**
     * clan set = developer, it's the tag their row shows
     *
     * @param {string} hash
     * @param {unknown} clan
     */
    remember(hash, clan){
        this.roster.add(hash);
        if (typeof clan === "string" && clan !== "") this.devs.set(hash, clan);
        else this.devs.delete(hash);
    }

    /**
     * @param {string} game
     * @param {unknown[]} players
     */
    setRoster(game, players){
        if (game === this.game && players.length === 0 && this.roster.size === 0) return;
        this.game = game;
        this.roster = new Set();
        this.devs = new Map();
        // ["<hash>", 0], or ["<hash>", 1, {c: "<clan tag>"}] for a dev
        for (const player of players){
            if (Array.isArray(player) && typeof player[0] === "string") this.remember(player[0], player[1] === 1 ? player[2]?.c : undefined);
        }
        this.changed();
    }

    changed(){
        for (const listener of this.listeners) listener();
    }
}

const presence = new Presence();
kute.presence = presence;
export default presence;
