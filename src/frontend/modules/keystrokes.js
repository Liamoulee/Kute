import styles from "../components/keystrokes.css";
import markup from "../components/keystrokes.html";
import { kute } from "../client.js";

/**
 * Movement keys and mouse in the HUD, lit while pressed. The keys follow the player's Krunker binds, read from
 * localStorage (cont_<action> and cont_<action>_alt hold keyCodes, -1 is unbound). Nothing runs per frame: the
 * movement ring only touches the DOM when an arc changes.
 */

// host sends left click as F20 while the pointer is locked
const LEFT_CLICK_KEY = 131;
const WHEEL_LIT_MS = 120;
// ramp boost turns a wheel tick into a 5 ms space press (input.rs), that space is not the player's
const SPACE = 32;
const RAMP_SPACE_MS = 80;
// smoothed pointer lock movement in counts per ms, so it depends on the mouse's dpi
const MOVE_FAST = 12;
// only the fading tail of the smoothing, any real movement is above it
const MOVE_MIN = 0.02;
// an arc needs this share of the movement, a sweep's sideways jitter stays under it and a diagonal lights two
const MOVE_SHARE = 0.35;
const MOVE_SMOOTH_MS = 20;
// no events come once the mouse stops, a timer turns the ring off
const MOVE_HOLD_MS = 80;

/** @type {[string, string, number][]} element id, bind, krunker's default */
const ACTIONS = [
    ["kuteKeyForward", "0", 87],
    ["kuteKeyBack", "1", 83],
    ["kuteKeyLeft", "2", 65],
    ["kuteKeyRight", "3", 68],
    ["kuteKeyJump", "jumpKey", 32],
    ["kuteKeyCrouch", "crouchKey", 16],
    ["kuteKeyReload", "reloadKey", 82],
    ["kuteKeyMelee", "meleeKey", 81],
    ["kuteKeySwap", "swapKey", 69],
];

/** @type {Record<number, string>} */
const KEY_LABELS = {
    8: "BKSP", 9: "TAB", 13: "ENT", 16: "SHIFT", 17: "CTRL", 18: "ALT", 20: "CAPS", 32: "SPACE",
    37: "←", 38: "↑", 39: "→", 40: "↓", 186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/",
    192: "`", 219: "[", 220: "\\", 221: "]", 222: "'",
};

/**
 * @param {number} code
 * @return {string}
 */
function keyLabel(code){
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90)) return String.fromCharCode(code);
    if (code >= 96 && code <= 105) return `N${code - 96}`;
    if (code >= 112 && code <= 123) return `F${code - 111}`;
    return KEY_LABELS[code] ?? "?";
}

/**
 * keyboard codes bound to an action, codes of 10000 and up are mouse buttons and the wheel
 *
 * @param {string} bind
 * @param {number} fallback
 * @return {number[]}
 */
function boundKeys(bind, fallback){
    /** @type {number[]} */
    const codes = [];
    let stored = false;
    for (const key of [`cont_${bind}_alt`, `cont_${bind}`]){
        let value = null;
        try {
            value = window.localStorage.getItem(key);
        }
        catch {
            value = null;
        }
        if (value === null) continue;
        stored = true;
        const code = Number(value);
        if (code > 0 && code < 10000) codes.push(code);
    }
    return stored ? codes : [fallback];
}

class Keystrokes {
    constructor(){
        /** @type {HTMLElement|null} */
        this.widget = null;
        /** @type {Map<number, HTMLElement[]>} */
        this.byCode = new Map();
        /** @type {Map<string, number>} */
        this.wheelTimers = new Map();
        this.rampWheelAt = -Infinity;
        this.spaceDownAt = -Infinity;
        this.spaceIgnored = false;
        /** @type {[HTMLElement, number, number][]} arc, x and y of its direction */
        this.arcs = [];
        this.moveX = 0;
        this.moveY = 0;
        this.lastMove = -Infinity;
        this.moveTimer = 0;

        /** @param {KeyboardEvent} event */
        this.onKeyDown = (event) => this.key(event.keyCode, true);
        /** @param {KeyboardEvent} event */
        this.onKeyUp = (event) => this.key(event.keyCode, false);
        /** @param {MouseEvent} event */
        this.onMouseDown = (event) => this.button(event.button, true);
        /** @param {MouseEvent} event */
        this.onMouseUp = (event) => this.button(event.button, false);
        /** @param {WheelEvent} event */
        this.onWheel = (event) => this.wheel(event.deltaY < 0);
        /** @param {MouseEvent} event */
        this.onMouseMove = (event) => this.move(event);
        this.onMoveIdle = () => {
            this.moveTimer = 0;
            const idle = performance.now() - this.lastMove;
            if (idle < MOVE_HOLD_MS){
                this.moveTimer = window.setTimeout(this.onMoveIdle, MOVE_HOLD_MS - idle);
                return;
            }
            this.moveX = 0;
            this.moveY = 0;
            this.drawMove();
        };
        /** @param {MessageEvent} event */
        this.onHostMessage = (event) => {
            // the host's wheel values are windows' sign, positive is up
            const { data } = event;
            if (typeof data?.wheel === "number" && data.wheel !== 0) this.wheel(data.wheel > 0);
            else if (typeof data?.rampWheel === "number" && data.rampWheel !== 0) this.rampWheel(data.rampWheel > 0);
        };
        this.releaseAll = () => {
            for (const lit of this.widget?.querySelectorAll(".on") ?? []) lit.classList.remove("on");
            this.moveX = 0;
            this.moveY = 0;
            this.drawMove();
        };
        // binds may have changed in the settings, entering the game picks them up
        this.onPointerLockChange = () => {
            if (document.pointerLockElement) this.readBinds();
            else this.releaseAll();
        };

        kute.settings.toggleKeystrokes = (enabled) => this.toggle(enabled);
        this.toggle(!!kute.settings.data.keystrokes);
    }

    /** @param {boolean} enabled */
    toggle(enabled){
        // changeSetting stores the new value after this returns, spotify's place depends on it
        queueMicrotask(() => kute.hudEditor?.apply());
        if (!enabled){
            this.remove();
            return;
        }
        if (this.widget) return;
        const style = document.createElement("style");
        style.id = "kuteKeystrokesCSS";
        style.textContent = styles;
        document.head.append(style);

        this.widget = document.createElement("div");
        this.widget.id = "kuteKeystrokes";
        this.widget.innerHTML = markup;
        (document.querySelector("#uiBase") ?? document.body).append(this.widget);
        this.readBinds();
        const { widget } = this;
        /** @type {[string, number, number][]} */
        const directions = [["kuteMoveLeft", -1, 0], ["kuteMoveRight", 1, 0], ["kuteMoveUp", 0, -1], ["kuteMoveDown", 0, 1]];
        this.arcs = directions.map(([id, x, y]) => [/** @type {HTMLElement} */ (widget.querySelector(`#${id}`)), x, y]);

        window.addEventListener("keydown", this.onKeyDown, true);
        window.addEventListener("keyup", this.onKeyUp, true);
        window.addEventListener("mousedown", this.onMouseDown, true);
        window.addEventListener("mouseup", this.onMouseUp, true);
        window.addEventListener("mousemove", this.onMouseMove, { capture: true, passive: true });
        window.addEventListener("wheel", this.onWheel, { capture: true, passive: true });
        window.addEventListener("blur", this.releaseAll);
        document.addEventListener("pointerlockchange", this.onPointerLockChange);
        window.chrome.webview.addEventListener("message", this.onHostMessage);
    }

    remove(){
        window.removeEventListener("keydown", this.onKeyDown, true);
        window.removeEventListener("keyup", this.onKeyUp, true);
        window.removeEventListener("mousedown", this.onMouseDown, true);
        window.removeEventListener("mouseup", this.onMouseUp, true);
        window.removeEventListener("mousemove", this.onMouseMove, true);
        window.removeEventListener("wheel", this.onWheel, true);
        window.removeEventListener("blur", this.releaseAll);
        document.removeEventListener("pointerlockchange", this.onPointerLockChange);
        window.chrome.webview.removeEventListener("message", this.onHostMessage);
        for (const timer of this.wheelTimers.values()) clearTimeout(timer);
        this.wheelTimers.clear();
        clearTimeout(this.moveTimer);
        this.moveTimer = 0;
        this.arcs = [];
        this.widget?.remove();
        this.widget = null;
        this.byCode.clear();
        document.querySelector("#kuteKeystrokesCSS")?.remove();
    }

    readBinds(){
        if (!this.widget) return;
        this.byCode.clear();
        for (const [id, bind, fallback] of ACTIONS){
            const element = /** @type {HTMLElement|null} */ (this.widget.querySelector(`#${id}`));
            if (!element) continue;
            const codes = boundKeys(bind, fallback);
            element.textContent = codes.length > 0 ? keyLabel(codes[0]) : "";
            element.title = codes.map(keyLabel).join(" / ");
            for (const code of codes){
                const list = this.byCode.get(code) ?? [];
                list.push(element);
                this.byCode.set(code, list);
            }
        }
    }

    /**
     * @param {number} code
     * @param {boolean} down
     */
    key(code, down){
        if (code === LEFT_CLICK_KEY){
            this.button(0, down);
            return;
        }
        if (code === SPACE){
            if (down){
                this.spaceDownAt = performance.now();
                this.spaceIgnored = this.spaceDownAt - this.rampWheelAt < RAMP_SPACE_MS;
            }
            const ignored = this.spaceIgnored;
            if (!down) this.spaceIgnored = false;
            if (ignored) return;
        }
        const elements = this.byCode.get(code);
        if (!elements) return;
        for (const element of elements) element.classList.toggle("on", down);
    }

    /**
     * @param {number} button
     * @param {boolean} down
     */
    button(button, down){
        const id = { 0: "kuteMouseLeft", 1: "kuteWheel", 2: "kuteMouseRight" }[button];
        if (id) this.widget?.querySelector(`#${id}`)?.classList.toggle("on", down);
    }

    /** @param {MouseEvent} event */
    move(event){
        if (document.pointerLockElement === null || this.arcs.length === 0) return;
        const now = event.timeStamp;
        // a pause counts as 100 ms, the first event after it barely moves the ring
        const elapsed = Math.min(now - this.lastMove, 100);
        this.lastMove = now;
        if (!(elapsed > 0)) return;
        const keep = Math.exp(-elapsed / MOVE_SMOOTH_MS);
        this.moveX = this.moveX * keep + (event.movementX / elapsed) * (1 - keep);
        this.moveY = this.moveY * keep + (event.movementY / elapsed) * (1 - keep);
        this.drawMove();
        if (!this.moveTimer) this.moveTimer = window.setTimeout(this.onMoveIdle, MOVE_HOLD_MS);
    }

    drawMove(){
        const total = Math.hypot(this.moveX, this.moveY);
        for (const [arc, x, y] of this.arcs){
            const speed = this.moveX * x + this.moveY * y;
            let name = "kuteMove";
            if (speed > MOVE_FAST) name = "kuteMove on fast";
            else if (total > MOVE_MIN && speed >= total * MOVE_SHARE) name = "kuteMove on";
            if (arc.className !== name) arc.className = name;
        }
    }

    /**
     * The wheel that ramp boost turned into space. The message can also come in just after that space.
     *
     * @param {boolean} up
     */
    rampWheel(up){
        this.rampWheelAt = performance.now();
        if (this.rampWheelAt - this.spaceDownAt < RAMP_SPACE_MS){
            this.spaceIgnored = true;
            for (const element of this.byCode.get(SPACE) ?? []) element.classList.remove("on");
        }
        this.wheel(up);
    }

    /** @param {boolean} up */
    wheel(up){
        if (!this.widget) return;
        const id = up ? "kuteWheelUp" : "kuteWheelDown";
        this.widget.querySelector(`#${id}`)?.classList.add("on");
        clearTimeout(this.wheelTimers.get(id));
        this.wheelTimers.set(id, window.setTimeout(() => {
            this.widget?.querySelector(`#${id}`)?.classList.remove("on");
            this.wheelTimers.delete(id);
        }, WHEEL_LIT_MS));
    }
}

export default new Keystrokes();
