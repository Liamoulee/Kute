import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { sourceKey } from "../util/rateLimit";
import { isDevelopment } from "../util/env";
import { isGameId, isPlayerHash, join, leave, type Member } from "../util/presence";
import { developerOf } from "../util/developers";
import { connectionClosed, connectionOpened, countFirstStart } from "../util/playerStats";

// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

/** bun's ws layer ignores maxPayload, so size is checked by hand */
const MAX_MESSAGE_BYTES = 512;
const MAX_MESSAGES = 10;
const MESSAGE_WINDOW_MS = 10 * 1000;
const MAX_SOCKETS_PER_SOURCE = isDevelopment ? 400 : 4;
const PING_INTERVAL_MS = 25 * 1000;
const ORIGIN = /^https:\/\/([a-z0-9-]+\.)?krunker\.io$/;

type Connection = { socket: WebSocket; alive: boolean };

const connections = new Set<Connection>();
const socketsPerSource = new Map<string, number>();
/** source -> day it last counted a first start (one per source per day) */
const firstStarts = new Map<string, string>();

const today = (): string => new Date().toISOString().slice(0, 10);

function mayCountFirstStart(source: string): boolean {
    const day = today();
    if (firstStarts.get(source) === day) return false;
    for (const [key, value] of firstStarts){
        if (value !== day) firstStarts.delete(key);
    }
    firstStarts.set(source, day);
    return true;
}

// server pings, not the client
setInterval(() => {
    for (const connection of connections){
        if (!connection.alive){
            connection.socket.terminate();
            continue;
        }
        connection.alive = false;
        connection.socket.ping();
    }
}, PING_INTERVAL_MS).unref();

export async function presenceRoutes(app: FastifyInstance): Promise<void> {
    app.get("/ws", { websocket: true }, (socket: WebSocket, req) => {
        // keeps non-game scripts out, not a security boundary (origin is easy to fake)
        if (!isDevelopment && !ORIGIN.test(req.headers.origin ?? "")){
            socket.close(1008);
            return;
        }
        const source = sourceKey(req.ip);
        const open = socketsPerSource.get(source) ?? 0;
        if (open >= MAX_SOCKETS_PER_SOURCE){
            socket.close(1013);
            return;
        }
        socketsPerSource.set(source, open + 1);

        const connection: Connection = { socket, alive: true };
        connections.add(connection);
        connectionOpened();

        const member: Member = {
            send: (text) => { if (socket.readyState === socket.OPEN) socket.send(text); },
            game: "",
            hash: "",
            dev: null,
        };
        // per-connection nonce so a recorded dev proof can't be replayed
        const nonce = randomBytes(16).toString("hex");
        member.send(JSON.stringify({ t: "hello", nonce }));
        let counted = false;
        let windowStart = Date.now();
        let messages = 0;

        socket.on("pong", () => { connection.alive = true; });

        socket.on("message", (data: Buffer) => {
            const now = Date.now();
            if (now - windowStart > MESSAGE_WINDOW_MS){
                windowStart = now;
                messages = 0;
            }
            if (++messages > MAX_MESSAGES || data.length > MAX_MESSAGE_BYTES){
                socket.close(1008);
                return;
            }

            let message: Record<string, unknown>;
            try {
                message = JSON.parse(data.toString());
            }
            catch {
                return;
            }
            if (typeof message !== "object" || message === null) return;

            if (message.t === "hi"){
                if (message.first === true && !counted && mayCountFirstStart(source)){
                    counted = true;
                    countFirstStart();
                    member.send("{\"t\":\"counted\"}");
                }
            }
            else if (message.t === "join"){
                if (isGameId(message.game) && isPlayerHash(message.hash)){
                    join(member, message.game, message.hash, developerOf(message.dev, nonce, message.game, message.hash));
                }
            }
            else if (message.t === "leave") leave(member);
        });

        socket.on("close", () => {
            leave(member);
            connections.delete(connection);
            connectionClosed();
            const left = (socketsPerSource.get(source) ?? 1) - 1;
            if (left <= 0) socketsPerSource.delete(source);
            else socketsPerSource.set(source, left);
        });

        socket.on("error", () => socket.terminate());
    });
}
