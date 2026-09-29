import { kute } from "../client.js";
import { setFrameEnd } from "./gameFpsLimit.js";

/**
 * Blends the last frames of the game canvas while the mouse turns the camera. The copy runs at the end of each
 * frame, after the game drew and before the paint, into a canvas between the game's and the HUD.
 * Nothing runs per frame while the camera stands still.
 */

const OVERLAY_ID = "kuteMotionBlur";
const REFERENCE_FRAME_MS = 1000 / 60;
// share of the previous frame kept at 60 fps with strength 100
const MAX_RETENTION = 0.5;
const MIN_WEIGHT = 0.002;
// camera turn in px per 60 fps frame
const TURN_START_PX = 3;
const TURN_FULL_PX = 30;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @return {number}
 */
function clamp(value, min, max){
    return Math.min(max, Math.max(min, value));
}

class MotionBlur {
    constructor(){
        this.enabled = false;
        this.running = false;
        this.moveX = 0;
        this.moveY = 0;
        this.weight = 0;
        this.lastFrame = 0;
        this.hasHistory = false;
        /** @type {HTMLCanvasElement|null} */
        this.game = null;
        /** @type {HTMLCanvasElement|null} */
        this.overlay = null;
        /** @type {CanvasRenderingContext2D|null} */
        this.context = null;

        /** @param {MouseEvent} event */
        this.onMouseMove = (event) => {
            if (document.pointerLockElement === null) return;
            this.moveX += event.movementX;
            this.moveY += event.movementY;
            if (!this.running){
                this.running = true;
                this.lastFrame = 0;
                setFrameEnd(this.onFrameEnd);
            }
        };
        this.onPointerLockChange = () => this.stop();
        /** @param {number} timestamp */
        this.onFrameEnd = (timestamp) => this.frame(timestamp);

        kute.settings.toggleMotionBlur = (enabled) => this.toggle(enabled);
        this.toggle(!!kute.settings.data.motionBlur);
    }

    /** @param {boolean} enabled */
    toggle(enabled){
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        if (enabled){
            window.addEventListener("mousemove", this.onMouseMove, true);
            document.addEventListener("pointerlockchange", this.onPointerLockChange);
            return;
        }
        window.removeEventListener("mousemove", this.onMouseMove, true);
        document.removeEventListener("pointerlockchange", this.onPointerLockChange);
        this.stop();
        this.overlay?.remove();
        this.overlay = null;
        this.context = null;
        this.game = null;
    }

    stop(){
        if (this.running) setFrameEnd(null);
        this.running = false;
        this.moveX = 0;
        this.moveY = 0;
        this.weight = 0;
        this.hasHistory = false;
        if (this.overlay) this.overlay.style.display = "none";
    }

    /** @return {boolean} */
    attach(){
        if (!this.game?.isConnected) this.game = document.querySelector("body > canvas:not([id])");
        const { game } = this;
        if (!game) return false;
        if (!this.overlay || !this.context){
            const overlay = document.createElement("canvas");
            overlay.id = OVERLAY_ID;
            // z-index 0: above the game's static canvas, below #game-overlay and #uiBase (both 1)
            overlay.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;contain:strict;display:none";
            const context = overlay.getContext("2d", { alpha: false });
            if (!context) return false;
            this.overlay = overlay;
            this.context = context;
        }
        if (this.overlay.previousElementSibling !== game) game.after(this.overlay);
        if (this.overlay.width !== game.width || this.overlay.height !== game.height){
            this.overlay.width = game.width;
            this.overlay.height = game.height;
            this.hasHistory = false;
        }
        return true;
    }

    /** @param {number} timestamp */
    frame(timestamp){
        const delta = this.lastFrame ? clamp(timestamp - this.lastFrame, 1, 100) : REFERENCE_FRAME_MS;
        this.lastFrame = timestamp;

        const turn = Math.hypot(this.moveX, this.moveY) * (REFERENCE_FRAME_MS / delta);
        this.moveX = 0;
        this.moveY = 0;
        const amount = clamp((turn - TURN_START_PX) / (TURN_FULL_PX - TURN_START_PX), 0, 1);
        const strength = clamp(Number(kute.settings.data.motionBlurStrength) || 0, 0, 100) / 100;
        const target = strength * MAX_RETENTION * amount * amount * (3 - 2 * amount);
        // quick to start, slower to fade out
        this.weight += (target - this.weight) * (1 - Math.exp(-delta / (target > this.weight ? 6 : 24)));

        if (this.weight < MIN_WEIGHT){
            this.stop();
            return;
        }
        if (!this.attach() || !this.overlay || !this.context || !this.game) return;

        const { context } = this;
        if (this.hasHistory){
            context.globalCompositeOperation = "source-over";
            // frame rate independent: the same trail length at 60 and at 1000 fps
            context.globalAlpha = 1 - this.weight ** (delta / REFERENCE_FRAME_MS);
        }
        else {
            context.globalCompositeOperation = "copy";
            context.globalAlpha = 1;
            this.hasHistory = true;
            this.overlay.style.display = "block";
        }
        context.drawImage(this.game, 0, 0);
    }
}

export default new MotionBlur();
