// krunker's official maps, index = id = preview image number, same order as gapi.svc.krunker.io/maps
export const OFFICIAL_MAPS = [
    "Burg", "Littletown", "Sandstorm", "Subzero", "Undergrowth", "Shipment", "Freight", "Lostworld", "Citadel", "Oasis",
    "Kanji", "Industry", "Lumber", "Evacuation", "Site", "SkyTemple", "Lagoon", "Bureau", "Tortuga", "Tropicano",
    "Krunk_Plaza", "Arena", "Habitat", "Atomic", "Old_Burg", "Throwback", "Stockade", "Facility", "Clockwork", "Laboratory",
    "Shipyard", "Soul Sanctum", "Bazaar", "Erupt", "HQ", "Khepri", "Lush", "Vivo", "Slide Moonlight", "Eterno Simulator",
    "Stalk Factory", "Eterno Jump", "Frontier", "Bastion", "Piazza", "Barnyard",
];

const MAPS_URL = "https://gapi.svc.krunker.io/maps";

/**
 * @param {number} id
 * @return {string}
 */
export const mapImageUrl = (id) => `https://assets.krunker.io/img/maps/map_${id}.png`;

/**
 * "eterno_jump" and "Krunk_Plaza" as the game list writes them
 *
 * @param {string} name
 * @return {string}
 */
export const mapLabel = (name) => name.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

/** @type {Promise<[number, string][]> | null} */
let live = null;

/**
 * the live list, so a map added mid season has a name and an image. the bundled one when krunker does not answer
 *
 * @return {Promise<[number, string][]>} id and name pairs
 */
export function officialMaps(){
    live ??= fetch(MAPS_URL, { signal: AbortSignal.timeout(4000) })
        .then((response) => response.json())
        .then((body) => {
            /** @type {[number, string][]} */
            const entries = [];
            for (const entry of Array.isArray(body?.data) ? body.data : []){
                if (Number.isInteger(entry?.id) && entry.id >= 0 && typeof entry?.name === "string") entries.push([entry.id, entry.name]);
            }
            if (entries.length === 0) throw new Error("empty map list");
            return entries;
        })
        .catch(() => {
            live = null;
            return OFFICIAL_MAPS.map((name, id) => /** @type {[number, string]} */ ([id, name]));
        });
    return live;
}
