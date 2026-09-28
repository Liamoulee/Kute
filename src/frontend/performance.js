import cSettings from "../cSettings.json";

/**
 * Performance mode overrides the cosmetic settings in memory only: settings.json keeps the player's values (the host
 * applies the same override in config.rs), so turning it off brings every one of them back.
 */

/** @type {Record<string, boolean|null>} setting id -> value while on, null only hides the row */
export const PERFORMANCE_VALUES = Object.fromEntries(
    Object.values(/** @type {Record<string, {id: string, performance?: boolean|null}>} */ (cSettings))
        .filter((setting) => setting.performance !== undefined)
        .map((setting) => [setting.id, setting.performance ?? null]),
);

/** @type {Record<string, any>} player's values of the overridden settings */
const stored = {};

/**
 * @param {Record<string, any>} data kute.settings.data
 * @param {string} id
 * @return {boolean}
 */
export function hiddenByPerformance(data, id){
    return data.performanceMode === true && id in PERFORMANCE_VALUES;
}

/**
 * Puts the performance values into `data`, or the player's values back.
 *
 * @param {Record<string, any>} data kute.settings.data
 * @param {boolean} on
 * @return {string[]} ids whose value changed
 */
export function overridePerformance(data, on){
    /** @type {string[]} */
    const changed = [];
    for (const [id, value] of Object.entries(PERFORMANCE_VALUES)){
        if (value === null) continue;
        const before = data[id];
        if (on){
            if (!(id in stored)) stored[id] = before;
            data[id] = value;
        }
        else if (id in stored){
            data[id] = stored[id];
            delete stored[id];
        }
        if (data[id] !== before) changed.push(id);
    }
    return changed;
}
