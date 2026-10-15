// ==UserScript==
// @name         Class Roulette
// @author       Kute
// @version      1.0.0
// @description  A random class every time you respawn, like Sharp Shooter in any mode
// @run-at       document-end
// @license      MIT
// ==/UserScript==

// shipped with kute as an example of a userscript in the crankshaft shape:
// `this.settings` is what the manager shows under the script, `this.unload` is called when the script gets turned off live,
// `this._console` is the real console (krunker replaces the page's one later), `this._css(css, id, on)` toggles a stylesheet.
// the game is only ever reached through its own ui: the death screen is read from a class on #uiBase, the class is picked
// by clicking the picker element krunker renders for every class the lobby allows

const CLASSES = [
    "Triggerman", "Hunter", "Run N Gun", "Spray N Pray", "Vince", "Detective", "Marksman", "Rocketeer",
    "Agent", "Runner", "Deagler", "Bowman", "Commando", "Trooper", "Survivor", "Infiltrator",
];
const PICKER = "menuClassPicker";

let noRepeat = 2;
/** @type {Record<number, boolean>} index -> may be drawn, missing means yes */
const allowed = {};
/** @type {number[]} the classes drawn so far, newest last */
const history = [];
let onDeathScreen = false;

const log = this._console;

const nameOf = (/** @type {number} */ index) => CLASSES[index] ?? `Class ${index}`;

const currentClassIndex = () => {
    const name = document.getElementById("menuClassName")?.textContent?.trim();
    const index = CLASSES.indexOf(name ?? "");
    return index >= 0 ? index : null;
};

const draw = () => {
    const pool = [];
    for (const element of document.querySelectorAll(`#hiddenClasses [id^="${PICKER}"]`)){
        const index = Number(element.id.slice(PICKER.length));
        if (Number.isInteger(index) && allowed[index] !== false) pool.push({ index, element });
    }
    if (pool.length === 0) return;

    // the class the player spawned with before the first draw counts as drawn
    const current = currentClassIndex();
    if (history.length === 0 && current !== null) history.push(current);

    // fewer classes than the no-repeat window: forget the oldest ones until something is left
    let choices = [];
    for (let skip = Math.min(noRepeat, history.length); choices.length === 0; skip--){
        const recent = skip > 0 ? history.slice(-skip) : [];
        choices = pool.filter((candidate) => !recent.includes(candidate.index));
    }

    const pick = choices[Math.floor(Math.random() * choices.length)];
    history.push(pick.index);
    if (history.length > CLASSES.length) history.shift();
    pick.element.click();
    log.log(`[class roulette] next class: ${nameOf(pick.index)}`);
};

// krunker toggles onDeathScrn on #uiBase when you die and drops it when the menu comes back
const uiBase = document.getElementById("uiBase");
const observer = new MutationObserver(() => {
    const dead = Boolean(uiBase?.classList.contains("onDeathScrn"));
    if (dead && !onDeathScreen) draw();
    onDeathScreen = dead;
});
if (uiBase) observer.observe(uiBase, { attributes: true, attributeFilter: ["class"] });
else log.warn("[class roulette] #uiBase not found, is this krunker?");

/** @type {Record<string, any>} */
const settings = {
    noRepeat: {
        title: "Don't repeat the last",
        desc: "How many of your previous classes are skipped when the next one is drawn",
        type: "num",
        value: noRepeat,
        min: 0,
        max: CLASSES.length - 1,
        step: 1,
        changed(/** @type {number} */ value){
            noRepeat = Math.max(0, Math.floor(value));
        },
    },
};
CLASSES.forEach((name, index) => {
    settings[`class${index}`] = {
        title: name,
        desc: "Off keeps this class out of the draw",
        type: "bool",
        value: true,
        changed(/** @type {boolean} */ value){
            allowed[index] = value;
        },
    };
});

this.settings = settings;
this.unload = () => observer.disconnect();
