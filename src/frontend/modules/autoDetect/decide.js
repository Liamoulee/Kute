import { TARGET_REFRESH_MULTIPLE } from "./policy.js";

/**
 * Which game settings to trade for frames. Pure. The client's pipeline and the fps cap are policy.js's business,
 * this only answers: does the PC reach its target, and if not, which measured setting pays for it.
 */

/** min gain for a setting to be worth a visual loss (samples jitter 1-4 %) */
export const SIGNIFICANT_SETTING = 1.05;
/** half res scale has to gain this much before we call it gpu bound */
export const SIGNIFICANT_RESOLUTION = 1.1;
export const MIN_RESOLUTION = 0.75;

/**
 * @typedef {object} MeasuredSetting
 * @property {string} id
 * @property {string} label
 * @property {string} current value before the run
 * @property {string} cheap
 * @property {number|null} gain fps with cheap / fps with the other, null when not measured
 * @property {boolean} steady whether the samples around it agreed
 * @property {string} [note] why there's no usable number
 * @property {number[]} [raw] report only: fps before, flipped, after
 * @property {number} [confirmGain] second measurement, if any
 */

/**
 * @typedef {object} Change
 * @property {string} id krunker's setting id
 * @property {string} label
 * @property {string|number|boolean} value
 * @property {string} reason
 */

/**
 * @typedef {object} QualityPlan
 * @property {number} target what Kute aims for, 3x the refresh rate
 * @property {number} needed target with this PC's own headroom
 * @property {boolean} holds the PC already reaches it uncapped
 * @property {"cpu"|"gpu"|"unknown"} regime what limits the fps
 * @property {number} predictedFps after the changes, from the measured gains
 * @property {boolean} tuneResolution whether the caller may lower res scale afterwards
 * @property {Change[]} changes
 */

/**
 * @param {{capacity: number, hz: number, headroom: number, halfResolutionGain: number|null, settings: MeasuredSetting[]}} measured
 *     capacity: fps without a cap. a cap the run picks never counts as a slow PC
 * @return {QualityPlan}
 */
export function decide({ capacity, hz, headroom, halfResolutionGain, settings }){
    const target = hz * TARGET_REFRESH_MULTIPLE;
    const needed = target * headroom;
    const holds = capacity >= needed;

    /** @type {QualityPlan["regime"]} */
    let regime = "unknown";
    if (halfResolutionGain !== null) regime = halfResolutionGain >= SIGNIFICANT_RESOLUTION ? "gpu" : "cpu";

    /** @type {Change[]} */
    const changes = [];
    // only trade quality while the target is missed, biggest measured gain first
    let predictedFps = capacity;
    if (!holds){
        const helpful = settings
            .filter((setting) => setting.gain !== null && setting.steady && setting.current !== setting.cheap && setting.gain >= SIGNIFICANT_SETTING)
            .sort((a, b) => (b.gain ?? 0) - (a.gain ?? 0));
        for (const setting of helpful){
            if (predictedFps >= needed) break;
            const gain = setting.gain ?? 1;
            predictedFps *= gain;
            changes.push({ id: setting.id, label: setting.label, value: setting.cheap, reason: `measured +${Math.round((gain - 1) * 100)} %` });
        }
    }

    return {
        target,
        needed,
        holds,
        regime,
        predictedFps,
        tuneResolution: !holds && regime === "gpu" && predictedFps < needed,
        changes,
    };
}
