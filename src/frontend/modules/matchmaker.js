// Custom matchmaker, ported from the Krunker Civilian Client (GPL-3.0), which took it from Crankshaft.
// F6 fetches the live lobby list, keeps the lobbies that pass the player's filters, sorts them by the ping
// to their region (measured by the host) and joins the best one, with a short scan animation meanwhile.
import styles from "../components/matchmaker.css";
import { kute } from "../client.js";
import { request } from "../utils.js";

// the index is the gamemode id of the game list (game[4].g)
const GAMEMODES = [
    "Free for All", "Team Deathmatch", "Hardpoint", "Capture the Flag", "Parkour", "Hide & Seek", "Infected", "Race",
    "Last Man Standing", "Simon Says", "Gun Game", "Prop Hunt", "Boss Hunt", "Classic FFA", "Deposit", "Stalker",
    "King of the Hill", "One in the Chamber", "Trade", "Kill Confirmed", "Defuse", "Sharp Shooter", "Traitor", "Raid",
    "Blitz", "Domination", "Squad Deathmatch", "Kranked FFA", "Team Defender", "Deposit FFA", "Chaos Snipers", "Bighead FFA",
];

// the modes offered in the filters
const MODE_FILTER = [
    "Free for All", "Team Deathmatch", "Hardpoint", "Capture the Flag", "Parkour", "Gun Game", "Classic FFA", "Deposit",
    "Kill Confirmed", "Sharp Shooter", "Domination", "Kranked FFA", "Team Defender", "Deposit FFA", "Chaos Snipers",
    "Bighead FFA",
];

/** @type {Record<string, string>} the prefix of a game id */
const REGIONS = {
    SV: "Silicon Valley", TOK: "Tokyo", FRA: "Frankfurt", MBI: "Mumbai", SYD: "Sydney",
    SIN: "Singapore", DAL: "Dallas", BHN: "Bahrain", BRZ: "Brazil", NY: "New York",
};

// the position is the number of the map's preview image on assets.krunker.io
const MAP_ICONS = [
    "Burg", "Littletown", "Sandstorm", "Subzero", "Undergrowth", "Shipment", "Freight", "Lostworld", "Citadel", "Oasis",
    "Kanji", "Industry", "Lumber", "Evacuation", "Site", "SkyTemple", "Lagoon", "Bureau", "Tortuga", "Tropicano",
    "Krunk_Plaza", "Arena", "Habitat", "Atomic", "Old_Burg", "Throwback", "Stockade", "Facility", "Clockwork", "Laboratory",
    "Shipyard", "Soul Sanctum", "Bazaar", "Erupt", "HQ", "Khepri", "Lush", "Vivo", "Slide Moonlight", "Eterno Simulator",
];

// the official maps offered in the filters. with none picked these are the filter, which keeps community maps out
const MAP_FILTER = [
    "Burg", "Littletown", "Sandstorm", "Subzero", "Undergrowth", "Freight", "Lostworld", "Citadel", "Oasis", "Kanji",
    "Industry", "Lumber", "Evacuation", "Site", "SkyTemple", "Lagoon", "Tropicano", "Habitat", "Atomic", "Old_Burg",
    "Throwback", "Clockwork", "Bazaar", "Erupt", "HQ", "Lush", "Vivo", "Slide Moonlight", "Eterno Simulator", "Eterno Jump",
    "Frontier",
];

/** @type {Record<string, string>} */
const MAP_NAMES = { SkyTemple: "Sky Temple", Krunk_Plaza: "Krunk Plaza", Old_Burg: "Old Burg" };

/**
 * The game list writes map ids its own way ("slide_moonlight" for "Slide Moonlight"), so both sides get compared like this.
 *
 * @param {string} name
 * @return {string}
 */
const normalizeMap = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

const MAP_ICON_BY_NAME = new Map(MAP_ICONS.map((name, index) => [normalizeMap(name), index]));
// maps added after the list above, their images exist beyond it
MAP_ICON_BY_NAME.set(normalizeMap("Eterno Jump"), 41);
MAP_ICON_BY_NAME.set(normalizeMap("Frontier"), 42);

const DEFAULT_MAPS = new Set(MAP_FILTER.map(normalizeMap));
// the parkour maps run without a round timer. an untimed lobby on any other map is a hosted custom game
const UNTIMED_MAPS = new Set(["Eterno Jump", "Slide Moonlight"].map(normalizeMap));

const GAME_LIST_URL = "https://matchmaker.krunker.io/game-list?hostname=krunker.io";
const FETCH_TIMEOUT_MS = 10000;
const MAX_FEED_ENTRIES = 4;
const MAX_ANIMATION_MS = 1100;
const BASE_TICK_MS = 80;
const MIN_TICK_MS = 20;
const POST_SCAN_PAUSE_MS = 180;
const FOUND_HOLD_MS = 1200;
const NOT_FOUND_HOLD_MS = 1100;

/**
 * @typedef {object} MatchmakerFilter
 * @property {string[]} regions Region codes (the prefix of a game id)
 * @property {string[]} modes
 * @property {string[]} maps In the order they were picked
 * @property {boolean} mapPriority The first map of `maps` that has a lobby wins, before ping and players
 * @property {number} minPlayers
 * @property {number} maxPlayers
 * @property {number} minTime Seconds left in the round
 * @property {boolean} sortByPlayers Most players first instead of lowest ping first
 * @property {boolean} serverBrowser Open the server browser when nothing matches
 * @property {boolean} animation Show the search popup
 */

/** @type {MatchmakerFilter} */
const DEFAULT_FILTER = {
    regions: [],
    modes: [],
    maps: [],
    mapPriority: false,
    minPlayers: 1,
    maxPlayers: 6,
    minTime: 120,
    sortByPlayers: false,
    serverBrowser: true,
    animation: true,
};

/**
 * @typedef {object} Lobby
 * @property {string} id
 * @property {string} region Region code, the prefix of the id
 * @property {string} server The region's server id, what the pings are keyed by
 * @property {number} players
 * @property {number} limit
 * @property {string} map
 * @property {string} mode
 * @property {number} timeLeft Seconds, 0 without a round timer
 * @property {boolean} passes
 */

/**
 * @param {number} ms
 * @return {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} map
 * @return {string|null}
 */
function mapIconUrl(map){
    const index = MAP_ICON_BY_NAME.get(normalizeMap(map));
    return index === undefined ? null : `https://assets.krunker.io/img/maps/map_${index}.png`;
}

/**
 * @param {string} map
 * @param {string} className
 * @return {HTMLImageElement|null}
 */
function mapIcon(map, className){
    const url = mapIconUrl(map);
    if (!url) return null;
    const img = document.createElement("img");
    img.className = className;
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => img.remove();
    return img;
}

/**
 * @param {string} className
 * @param {string} text
 * @return {HTMLSpanElement}
 */
function span(className, text){
    const element = document.createElement("span");
    element.className = className;
    element.textContent = text;
    return element;
}

/**
 * @param {Lobby} lobby
 * @param {string} className
 * @return {HTMLDivElement}
 */
function lobbyEntry(lobby, className){
    const entry = document.createElement("div");
    entry.className = `mm-entry ${className}`;
    const icon = mapIcon(lobby.map, "mm-icon");
    if (icon) entry.append(icon);
    entry.append(span("mm-region", lobby.region), span("mm-map", lobby.map), span("mm-players", `${lobby.players}/${lobby.limit}`));
    return entry;
}

/**
 * @return {Promise<any[]>} The raw game list entries
 */
async function fetchGameList(){
    const response = await fetch(GAME_LIST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const result = await response.json();
    return Array.isArray(result?.games) ? result.games : [];
}

/**
 * @param {any[]} games
 * @param {MatchmakerFilter} filter
 * @return {Lobby[]}
 */
function readLobbies(games, filter){
    const maps = filter.maps.length > 0 ? new Set(filter.maps.map(normalizeMap)) : DEFAULT_MAPS;
    return games.map((game) => {
        const id = String(game[0]);
        const map = String(game[4]?.i ?? "");
        const mapId = normalizeMap(map);
        /** @type {Lobby} */
        const lobby = {
            id,
            region: id.split(":")[0],
            server: String(game[1]),
            players: Number(game[2]),
            limit: Number(game[3]),
            map,
            mode: GAMEMODES[game[4]?.g] ?? "Unknown",
            timeLeft: Number(game[5]),
            passes: false,
        };
        lobby.passes =
            (filter.regions.length === 0 || filter.regions.includes(lobby.region)) &&
            (filter.modes.length === 0 || filter.modes.includes(lobby.mode)) &&
            maps.has(mapId) &&
            lobby.players >= filter.minPlayers &&
            lobby.players <= filter.maxPlayers &&
            lobby.players < lobby.limit &&
            // 0 means no round timer, not "0 seconds left"
            (lobby.timeLeft > 0 ? lobby.timeLeft >= filter.minTime : UNTIMED_MAPS.has(mapId)) &&
            !location.href.includes(id);
        return lobby;
    });
}

class Matchmaker {
    constructor(){
        // id of the running search, 0 when idle. a new id per search, so a stale continuation knows it was cancelled
        this.activeRun = 0;
        this.runCounter = 0;
        /** @type {Lobby[]} */
        this.candidates = [];

        this.popup = document.createElement("div");
        this.popup.id = "kuteMatchmaker";
        this.status = document.createElement("div");
        this.status.id = "kuteMmStatus";
        this.feed = document.createElement("div");
        this.feed.id = "kuteMmFeed";
        this.counter = document.createElement("div");
        this.counter.id = "kuteMmCounter";
        const cancel = document.createElement("div");
        cancel.id = "kuteMmCancel";
        cancel.textContent = "Cancel";
        cancel.onmouseenter = () => window.SOUND?.play("tick_0", 0.1);
        cancel.onclick = () => this.abort();
        this.popup.append(this.status, this.feed, this.counter, cancel);

        /** @param {KeyboardEvent} event */
        this.cancelKey = (event) => {
            if (event.key !== "Escape" || document.pointerLockElement) return;
            event.preventDefault();
            event.stopPropagation();
            this.abort();
        };

        kute.matchmaker = { showFilters: () => this.showFilters() };
        // F6 checks the setting on every press, and the host leaves F6 alone while it is on
        kute.settings.toggleMatchmaker = () => {};

        // the host announces that it leaves F6 to the page, an older exe would load a new lobby at the same time
        if (!kute.hostFeatures?.includes("matchmaker")) return;
        window.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "F6" || event.repeat || !kute.settings.data.matchmaker) return;
                if (document.activeElement?.tagName === "INPUT") return;
                this.start().catch((error) => console.error("[kute] matchmaker:", error));
            },
            true,
        );
    }

    /**
     * @return {MatchmakerFilter}
     */
    get filter(){
        return { ...DEFAULT_FILTER, ...kute.settings.data.matchmakerFilter };
    }

    /**
     * @param {MatchmakerFilter} filter
     */
    saveFilter(filter){
        kute.settings.data.matchmakerFilter = filter;
        window.chrome.webview.postMessage(`set-config-json matchmakerFilter ${JSON.stringify(filter)}`);
    }

    /**
     * @param {number} run
     * @return {boolean}
     */
    cancelled(run){
        return run !== this.activeRun;
    }

    abort(){
        this.activeRun = 0;
        window.playSelect?.();
        this.dismiss();
    }

    dismiss(){
        document.removeEventListener("keydown", this.cancelKey, true);
        this.popup.remove();
    }

    showPopup(){
        if (!document.querySelector("#kuteMatchmakerCSS")){
            const css = document.createElement("style");
            css.id = "kuteMatchmakerCSS";
            css.textContent = styles;
            document.head.append(css);
        }
        this.status.textContent = "Connecting...";
        this.status.classList.remove("mm-fail");
        this.feed.replaceChildren();
        this.feed.classList.remove("mm-result");
        this.counter.textContent = "";
        document.addEventListener("keydown", this.cancelKey, true);
        (document.querySelector("#uiBase") ?? document.body).append(this.popup);
    }

    /**
     * @param {HTMLElement} entry
     */
    pushEntry(entry){
        this.feed.append(entry);
        while (this.feed.children.length > MAX_FEED_ENTRIES) this.feed.firstElementChild?.remove();
    }

    /**
     * Scrolls through the lobbies and, with a match, settles on it.
     *
     * @param {number} run
     * @param {Lobby[]} lobbies
     * @param {Lobby} [best]
     */
    async animateScan(run, lobbies, best){
        const total = lobbies.length;
        if (total === 0) return;
        this.status.textContent = "Scanning lobbies...";

        const maxEntries = Math.floor(MAX_ANIMATION_MS / BASE_TICK_MS);
        const step = total > maxEntries ? total / maxEntries : 1;
        const tickMs = total > maxEntries ? BASE_TICK_MS : Math.max(MIN_TICK_MS, Math.min(BASE_TICK_MS, MAX_ANIMATION_MS / total));

        for (let f = 0; f < total; f += step){
            if (this.cancelled(run)) return;
            const index = Math.min(Math.floor(f), total - 1);
            this.pushEntry(lobbyEntry(lobbies[index], lobbies[index].passes ? "mm-pass" : "mm-skip"));
            this.counter.textContent = `Checked: ${index + 1} / ${total} lobbies`;
            await sleep(tickMs);
        }
        if (this.cancelled(run)) return;
        this.counter.textContent = `Checked: ${total} / ${total} lobbies`;
        if (best) this.pushEntry(lobbyEntry(best, "mm-pass mm-landed"));
        await sleep(POST_SCAN_PAUSE_MS);
    }

    /**
     * Leaves the page for the lobby, the way F4 does it on the host.
     *
     * @param {string} id
     */
    join(id){
        this.dismiss();
        window.chrome.webview.postMessage("throttle, off");
        window.chrome.webview.postMessage("drag, true");
        location.href = `https://krunker.io/?game=${id}`;
    }

    /**
     * @param {MatchmakerFilter} filter
     */
    openServerBrowser(filter){
        this.dismiss();
        if (filter.serverBrowser) window.openServerWindow?.(0);
    }

    /**
     * The picked lobby may have filled up during the animation: checks the live list again and joins the first
     * candidate that still has room.
     *
     * @param {number} run
     * @param {Lobby} best
     * @param {MatchmakerFilter} filter
     */
    async verifyAndJoin(run, best, filter){
        let games;
        try {
            games = await fetchGameList();
        }
        catch {
            if (!this.cancelled(run)) this.join(best.id);
            return;
        }
        if (this.cancelled(run)) return;

        const live = new Map(games.map((game) => [String(game[0]), { players: Number(game[2]), limit: Number(game[3]) }]));
        const ordered = [best, ...this.candidates.filter((lobby) => lobby !== best)];
        const open = ordered.find((lobby) => {
            const game = live.get(lobby.id);
            return game && game.players < game.limit;
        });
        if (open) this.join(open.id);
        else this.openServerBrowser(filter);
    }

    /**
     * Repeated presses during a search are ignored, Escape or the button cancel it.
     */
    async start(){
        if (this.activeRun !== 0) return;
        const run = ++this.runCounter;
        this.activeRun = run;
        try {
            await this.search(run);
        }
        finally {
            if (this.activeRun === run) this.activeRun = 0;
        }
    }

    /**
     * @param {number} run
     */
    async search(run){
        const { filter } = this;
        // without the popup there is nothing to cancel either
        if (filter.animation) this.showPopup();

        /** @type {Lobby[]} */
        let lobbies;
        /** @type {Record<string, number>} */
        let pings;
        try {
            const [games, regionPings] = await Promise.all([fetchGameList(), request("ping-regions", "regionPings", FETCH_TIMEOUT_MS)]);
            lobbies = readLobbies(games, filter);
            pings = regionPings ?? {};
        }
        catch (error){
            console.error("[kute] matchmaker: no lobby list", error);
            if (this.cancelled(run) || !filter.animation) return;
            this.status.textContent = "Failed to fetch lobbies";
            this.status.classList.add("mm-fail");
            await sleep(2000);
            if (!this.cancelled(run)) this.dismiss();
            return;
        }
        if (this.cancelled(run)) return;

        /** @param {Lobby} lobby */
        const ping = (lobby) => pings[lobby.server] ?? 999;
        // with map priority on, the map's place in the list comes before ping and players
        const mapRanks = new Map(filter.mapPriority ? filter.maps.map((map, index) => [normalizeMap(map), index]) : []);
        /** @param {Lobby} lobby */
        const rank = (lobby) => mapRanks.get(normalizeMap(lobby.map)) ?? 0;
        const passing = lobbies.filter((lobby) => lobby.passes);
        passing.sort((a, b) => {
            const byRank = rank(a) - rank(b);
            const byPing = ping(a) - ping(b);
            const byPlayers = b.players - a.players;
            if (filter.sortByPlayers) return byRank || byPlayers || byPing;
            return byRank || byPing || byPlayers;
        });
        this.candidates = passing;

        // a random one of the lobbies about as good as the best, so everyone pressing F6 does not end up in the same one
        /** @type {Lobby|undefined} */
        let best;
        if (passing.length > 0){
            const top = passing[0];
            const pool = passing.filter(
                (lobby) => rank(lobby) === rank(top) && Math.abs(ping(lobby) - ping(top)) <= 20 && top.players - lobby.players <= 2,
            );
            best = pool[Math.floor(Math.random() * pool.length)];
        }

        if (filter.animation) await this.animateScan(run, lobbies, best);
        if (this.cancelled(run)) return;

        if (!best){
            if (filter.animation){
                this.status.textContent = "No Lobby Found";
                this.status.classList.add("mm-fail");
                this.feed.classList.add("mm-result");
                const none = document.createElement("div");
                none.className = "mm-entry mm-none";
                none.textContent = "No matching lobbies";
                this.feed.replaceChildren(none);
                this.counter.textContent = filter.serverBrowser ? "Opening server browser..." : "";
                await sleep(NOT_FOUND_HOLD_MS);
                if (this.cancelled(run)) return;
            }
            this.openServerBrowser(filter);
            return;
        }

        if (filter.animation){
            this.status.textContent = "Lobby Found!";
            this.feed.classList.add("mm-result");
            this.feed.replaceChildren(lobbyEntry(best, "mm-pass mm-found"));
            const pingText = pings[best.server] === undefined ? "?" : String(pings[best.server]);
            this.counter.textContent = `${best.mode} · ${REGIONS[best.region] ?? best.region} · ${pingText}ms`;
            await sleep(FOUND_HOLD_MS);
            if (this.cancelled(run)) return;
        }
        await this.verifyAndJoin(run, best, filter);
    }

    /**
     * The filter popup behind the setting's button. Saves when it closes.
     */
    async showFilters(){
        const html = await import("../components/matchmakerFilters.html");
        const { filter } = this;

        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = html.default;

        /**
         * @param {string} id
         * @return {HTMLInputElement}
         */
        const element = (id) => /** @type {HTMLInputElement} */ (shadow.querySelector(`#${id}`));

        /**
         * One toggle chip per item, bound to the list of picked values.
         *
         * @param {string} gridId
         * @param {{value: string, label: string, icon?: string|null}[]} items
         * @param {string[]} picked Changed in place
         * @param {() => void} [onChange]
         */
        const chips = (gridId, items, picked, onChange) => {
            const grid = element(gridId);
            grid.replaceChildren();
            for (const item of items){
                const chip = document.createElement("div");
                chip.className = `mmChip${picked.includes(item.value) ? " on" : ""}`;
                if (item.icon){
                    const img = document.createElement("img");
                    img.src = item.icon;
                    img.alt = "";
                    img.loading = "lazy";
                    img.onerror = () => img.remove();
                    chip.append(img);
                }
                chip.append(item.label);
                chip.onclick = () => {
                    const index = picked.indexOf(item.value);
                    if (index === -1) picked.push(item.value);
                    else picked.splice(index, 1);
                    chip.classList.toggle("on", index === -1);
                    onChange?.();
                };
                grid.append(chip);
            }
        };

        /**
         * The picked maps as a ranked row: drag a chip to reorder, click it to move it to the top. Pointer events
         * instead of HTML5 drag and drop, the host refuses every drag that enters the browser window.
         */
        const renderPriority = () => {
            const list = element("mmPriority");
            element("mmPriorityRow").hidden = filter.maps.length < 2;
            element("mmPriorityBox").hidden = filter.maps.length < 2 || !element("mmMapPriority").checked;
            list.replaceChildren();
            const renumber = () => list.querySelectorAll(".mmNum").forEach((num, index) => (num.textContent = String(index + 1)));

            for (const value of filter.maps){
                const chip = document.createElement("div");
                chip.className = "mmChip on mmRank";
                chip.append(span("mmNum", ""));
                const icon = mapIconUrl(value);
                if (icon){
                    const img = document.createElement("img");
                    img.src = icon;
                    img.alt = "";
                    img.draggable = false;
                    img.onerror = () => img.remove();
                    chip.append(img);
                }
                chip.append(MAP_NAMES[value] ?? value);

                /** @type {{x: number, y: number, moved: boolean}|null} */
                let drag = null;
                chip.onpointerdown = (event) => {
                    chip.setPointerCapture(event.pointerId);
                    drag = { x: event.clientX, y: event.clientY, moved: false };
                };
                chip.onpointermove = (event) => {
                    if (!drag) return;
                    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
                    drag.moved = true;
                    chip.classList.add("dragging");
                    const children = [...list.children];
                    const target = children.findIndex((child) => {
                        const rect = child.getBoundingClientRect();
                        return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
                    });
                    const from = children.indexOf(chip);
                    if (target === -1 || target === from) return;
                    filter.maps.splice(target, 0, ...filter.maps.splice(from, 1));
                    chip.remove();
                    list.insertBefore(chip, list.children[target] ?? null);
                    renumber();
                };
                chip.onpointerup = () => {
                    chip.classList.remove("dragging");
                    if (drag && !drag.moved){
                        filter.maps.unshift(...filter.maps.splice(filter.maps.indexOf(value), 1));
                        window.SOUND?.play("tick_0", 0.1);
                        renderPriority();
                    }
                    drag = null;
                };
                chip.onpointercancel = chip.onpointerup;
                list.append(chip);
            }
            renumber();
        };

        const fill = () => {
            chips("mmRegions", Object.entries(REGIONS).map(([value, label]) => ({ value, label })), filter.regions);
            chips("mmModes", MODE_FILTER.map((value) => ({ value, label: value })), filter.modes);
            chips(
                "mmMaps",
                MAP_FILTER.map((value) => ({ value, label: MAP_NAMES[value] ?? value, icon: mapIconUrl(value) })),
                filter.maps,
                renderPriority,
            );
            element("mmMapPriority").checked = filter.mapPriority;
            renderPriority();
            element("mmMinPlayers").value = String(filter.minPlayers);
            element("mmMaxPlayers").value = String(filter.maxPlayers);
            element("mmMinTime").value = String(filter.minTime);
            element("mmSortByPlayers").checked = filter.sortByPlayers;
            element("mmServerBrowser").checked = filter.serverBrowser;
            element("mmAnimation").checked = filter.animation;
        };
        // copies, the chips change the lists in place
        filter.regions = [...filter.regions];
        filter.modes = [...filter.modes];
        filter.maps = [...filter.maps];
        fill();

        /**
         * @param {string} id
         * @param {number} min
         * @param {number} max
         * @param {number} fallback
         * @return {number}
         */
        const number = (id, min, max, fallback) => {
            const value = Number.parseInt(element(id).value, 10);
            return Number.isNaN(value) ? fallback : Math.min(max, Math.max(min, value));
        };

        const controller = new AbortController();
        const close = () => {
            controller.abort();
            overlay.remove();
            this.saveFilter({
                ...filter,
                minPlayers: number("mmMinPlayers", 0, 7, DEFAULT_FILTER.minPlayers),
                maxPlayers: number("mmMaxPlayers", 0, 7, DEFAULT_FILTER.maxPlayers),
                minTime: number("mmMinTime", 0, 480, DEFAULT_FILTER.minTime),
                mapPriority: element("mmMapPriority").checked,
                sortByPlayers: element("mmSortByPlayers").checked,
                serverBrowser: element("mmServerBrowser").checked,
                animation: element("mmAnimation").checked,
            });
        };
        element("mmDone").onclick = close;
        element("mmMapPriority").onchange = renderPriority;
        element("mmReset").onclick = () => {
            Object.assign(filter, DEFAULT_FILTER, { regions: [], modes: [], maps: [] });
            fill();
        };
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
    }
}

export default new Matchmaker();
