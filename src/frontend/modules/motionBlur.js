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

const VERTEX = `#version 300 es
void main(){
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** @param {string} gamma */
const accumulateShader = (gamma) => `#version 300 es
precision highp float;
uniform sampler2D source;
out vec4 color;
void main(){
    ivec2 size = textureSize(source, 0);
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 c = texelFetch(source, ivec2(p.x, size.y - 1 - p.y), 0).rgb;
    color = vec4(pow(c, vec3(${gamma})), 1.0);
}`;

/** @param {string} gamma */
const presentShader = (gamma) => `#version 300 es
precision highp float;
uniform sampler2D history;
out vec4 color;
void main(){
    color = vec4(pow(texelFetch(history, ivec2(gl_FragCoord.xy), 0).rgb, vec3(1.0 / ${gamma})), 1.0);
}`;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @return {number}
 */
function clamp(value, min, max){
    return Math.min(max, Math.max(min, value));
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} fragment
 * @return {WebGLProgram|null}
 */
function compile(gl, fragment){
    const program = gl.createProgram();
    for (const [type, source] of /** @type {const} */ ([[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]])){
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
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
        /** @type {WebGL2RenderingContext|null} */
        this.gl = null;
        /** @type {WebGLProgram|null} */
        this.accumulate = null;
        /** @type {WebGLProgram|null} */
        this.present = null;
        /** @type {WebGLTexture|null} */
        this.source = null;
        /** @type {WebGLTexture|null} */
        this.history = null;
        /** @type {WebGLFramebuffer|null} */
        this.historyBuffer = null;
        this.historyFormat = 0;
        this.unsupported = false;

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
        this.onContextLost = () => this.release();

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
        this.unsupported = false;
        this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
        this.release();
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

    release(){
        this.overlay?.removeEventListener("webglcontextlost", this.onContextLost);
        this.overlay?.remove();
        this.overlay = null;
        this.gl = null;
        this.accumulate = null;
        this.present = null;
        this.source = null;
        this.history = null;
        this.historyBuffer = null;
        this.hasHistory = false;
    }

    /** @return {boolean} */
    createContext(){
        const overlay = document.createElement("canvas");
        overlay.id = OVERLAY_ID;
        // z-index 0: above the game's static canvas, below #game-overlay and #uiBase (both 1)
        overlay.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;contain:strict;display:none";
        const gl = overlay.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
        if (!gl) return false;

        // an 8 bit history gets stuck a few levels off the real image once the per frame blend is small (high fps),
        // and linear light in 8 bit bands in the darks, so that fallback blends in srgb
        const float = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
        const gamma = float ? "2.2" : "1.0";
        const accumulate = compile(gl, accumulateShader(gamma));
        const present = compile(gl, presentShader(gamma));
        if (!accumulate || !present) return false;

        gl.useProgram(accumulate);
        gl.uniform1i(gl.getUniformLocation(accumulate, "source"), 0);
        gl.useProgram(present);
        gl.uniform1i(gl.getUniformLocation(present, "history"), 1);

        const source = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, source);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        const history = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, history);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        const historyBuffer = gl.createFramebuffer();
        gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);

        overlay.addEventListener("webglcontextlost", this.onContextLost);
        this.overlay = overlay;
        this.gl = gl;
        this.accumulate = accumulate;
        this.present = present;
        this.source = source;
        this.history = history;
        this.historyBuffer = historyBuffer;
        this.historyFormat = float ? gl.RGBA16F : gl.RGBA8;
        return true;
    }

    /** @return {boolean} */
    attach(){
        if (!this.game?.isConnected) this.game = document.querySelector("body > canvas:not([id])");
        const { game } = this;
        if (!game) return false;
        if (!this.overlay && (this.unsupported || !this.createContext())){
            this.unsupported = true;
            return false;
        }
        const { overlay, gl } = this;
        if (!overlay || !gl) return false;
        if (overlay.previousElementSibling !== game) game.after(overlay);
        if (overlay.width !== game.width || overlay.height !== game.height){
            overlay.width = game.width;
            overlay.height = game.height;
            gl.viewport(0, 0, game.width, game.height);
            gl.activeTexture(gl.TEXTURE1);
            gl.texImage2D(gl.TEXTURE_2D, 0, this.historyFormat, game.width, game.height, 0, gl.RGBA, this.historyFormat === gl.RGBA8 ? gl.UNSIGNED_BYTE : gl.HALF_FLOAT, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.historyBuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.history, 0);
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
        if (!this.attach() || !this.overlay || !this.gl || !this.game){
            this.stop();
            return;
        }

        const { gl, overlay, game } = this;
        gl.activeTexture(gl.TEXTURE0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, game);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.historyBuffer);
        gl.useProgram(this.accumulate);
        if (this.hasHistory){
            gl.enable(gl.BLEND);
            // frame rate independent: the same trail length at 60 and at 1000 fps
            gl.blendColor(0, 0, 0, 1 - this.weight ** (delta / REFERENCE_FRAME_MS));
        }
        else gl.disable(gl.BLEND);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(this.present);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        if (!this.hasHistory){
            this.hasHistory = true;
            // krunker's in-game saturation and hue are a css filter on its canvas, this canvas covers it
            overlay.style.filter = game.style.filter;
            overlay.style.display = "block";
        }
    }
}

export default new MotionBlur();
