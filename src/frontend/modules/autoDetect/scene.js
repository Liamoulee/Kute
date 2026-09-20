/**
 * @typedef {object} SceneLoad - Synthetic WebGL2 load shaped like a Krunker frame
 * @property {number} draws Draw calls per frame
 * @property {number} meshSegments Sphere resolution, 10 gives 200 triangles per object
 * @property {number} overdraw Screen covering translucent passes per frame (the GPU fill cost)
 * @property {number} cpuIterations Fixed JS work per frame. Iterations, not time, so a slower CPU shows
 */

/**
 * Calibrated on an RTX 3090 Ti at 3440x1440: about 1500 frames per second, which is what Krunker reaches there.
 *
 * @type {SceneLoad}
 */
export const DEFAULT_LOAD = {
    draws: 1200,
    meshSegments: 10,
    overdraw: 4,
    cpuIterations: 200000,
};

const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform vec3 uColor;
out vec3 vColor;
void main() {
    vec3 n = normalize(mat3(uModel) * aNormal);
    float light = 0.35 + 0.65 * max(dot(n, normalize(vec3(0.4, 0.8, 0.5))), 0.0);
    vColor = uColor * light;
    gl_Position = uViewProj * uModel * vec4(aPos, 1.0);
}`;

const MESH_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }`;

const FILL_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FILL_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform float uTime;
uniform float uLayer;
out vec4 outColor;
void main() {
    float w = sin(vUv.x * 40.0 + uTime + uLayer) * cos(vUv.y * 30.0 - uTime * 0.7);
    outColor = vec4(0.3 + 0.2 * w, 0.2, 0.4 - 0.2 * w, 0.08);
}`;

const LABEL_VS = `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec2 uScale;
out vec2 vUv;
void main() { vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos * uScale, 0.0, 1.0); }`;

const LABEL_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uLabel;
out vec4 outColor;
void main() { outColor = texture(uLabel, vUv); }`;

/**
 * Text for the player, painted once into a bitmap. It is drawn as part of the scene: an HTML element over
 * the canvas would make the browser composite two layers per frame, which costs a good tenth of the frame
 * rate and would end up in the measurement.
 *
 * @param {string[]} lines The first one is the headline
 * @return {HTMLCanvasElement}
 */
function paintLabel(lines){
    const bitmap = document.createElement("canvas");
    bitmap.width = 640;
    bitmap.height = 60 + lines.length * 34;
    const context = bitmap.getContext("2d");
    if (!context) return bitmap;
    context.fillStyle = "rgba(30, 30, 30, 0.92)";
    context.beginPath();
    context.roundRect(0, 0, bitmap.width, bitmap.height, 18);
    context.fill();
    context.textAlign = "center";
    context.textBaseline = "middle";
    lines.forEach((line, index) => {
        context.font = index === 0 ? "26px Consolas, monospace" : "18px Consolas, monospace";
        context.fillStyle = index === 0 ? "#35e0e8" : "#bbbbbb";
        context.fillText(line, bitmap.width / 2, 48 + index * 34);
    });
    return bitmap;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} type
 * @param {string} source
 * @return {WebGLShader}
 */
function compile(gl, type, source){
    const shader = gl.createShader(type);
    if (!shader) throw new Error("cannot create shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
    return shader;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertexSource
 * @param {string} fragmentSource
 * @return {WebGLProgram}
 */
function link(gl, vertexSource, fragmentSource){
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
    return program;
}

/**
 * @param {number} segments
 * @return {{positions: Float32Array, indices: Uint16Array}}
 */
function sphere(segments){
    const positions = [];
    const indices = [];
    for (let y = 0; y <= segments; y++){
        const phi = (y / segments) * Math.PI;
        for (let x = 0; x <= segments; x++){
            const theta = (x / segments) * Math.PI * 2;
            positions.push(Math.cos(theta) * Math.sin(phi), Math.cos(phi), Math.sin(theta) * Math.sin(phi));
        }
    }
    for (let y = 0; y < segments; y++){
        for (let x = 0; x < segments; x++){
            const a = y * (segments + 1) + x;
            const b = a + segments + 1;
            indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
    }
    return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}

/**
 * @param {Float32Array} out
 * @param {number} fovY
 * @param {number} aspect
 * @param {number} near
 * @param {number} far
 */
function perspective(out, fovY, aspect, near, far){
    const f = 1 / Math.tan(fovY / 2);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
}

/**
 * Column major a * b.
 *
 * @param {Float32Array} out
 * @param {Float32Array} a
 * @param {Float32Array} b
 */
function multiply(out, a, b){
    for (let c = 0; c < 4; c++){
        for (let r = 0; r < 4; r++){
            out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    }
}

/**
 * Rotation around Y, uniform scale and translation.
 *
 * @param {Float32Array} out
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} angle
 * @param {number} scale
 */
function modelMatrix(out, x, y, z, angle, scale){
    const c = Math.cos(angle) * scale;
    const s = Math.sin(angle) * scale;
    out.fill(0);
    out[0] = c;
    out[2] = -s;
    out[5] = scale;
    out[8] = s;
    out[10] = c;
    out[12] = x;
    out[13] = y;
    out[14] = z;
    out[15] = 1;
}

const cpuBuffer = new Float32Array(4096);
let cpuSink = 0;

/**
 * @param {number} iterations
 */
function cpuWork(iterations){
    let acc = 0;
    for (let i = 0; i < iterations; i++){
        const j = i & 4095;
        cpuBuffer[j] = cpuBuffer[j] * 0.999 + Math.sqrt(i + 1) * 0.001;
        acc += cpuBuffer[j];
    }
    // keeps the loop from being optimized away
    cpuSink += acc;
}

/**
 * @typedef {object} Scene
 * @property {(timeMs: number) => void} render Draws one frame
 * @property {(width: number, height: number) => void} resize
 * @property {() => boolean} lost Whether the GL context is gone, which is what a closing window looks like
 * @property {() => void} destroy
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {SceneLoad} [load]
 * @param {string[]} [labelLines] Shown in the middle of the scene for the whole run
 * @return {Scene}
 */
export function createScene(canvas, load = DEFAULT_LOAD, labelLines = []){
    const gl = canvas.getContext("webgl2", {
        antialias: false,
        alpha: false,
        depth: true,
        preserveDrawingBuffer: false,
        powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 unavailable");

    const meshProgram = link(gl, MESH_VS, MESH_FS);
    const uModel = gl.getUniformLocation(meshProgram, "uModel");
    const uViewProj = gl.getUniformLocation(meshProgram, "uViewProj");
    const uColor = gl.getUniformLocation(meshProgram, "uColor");

    const fillProgram = link(gl, FILL_VS, FILL_FS);
    const uTime = gl.getUniformLocation(fillProgram, "uTime");
    const uLayer = gl.getUniformLocation(fillProgram, "uLayer");

    const mesh = sphere(load.meshSegments);
    const meshVao = gl.createVertexArray();
    gl.bindVertexArray(meshVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    // a unit sphere's positions are its normals
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    const fillVao = gl.createVertexArray();
    gl.bindVertexArray(fillVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // the label: one textured quad, the same single draw call in every configuration
    const labelBitmap = labelLines.length > 0 ? paintLabel(labelLines) : null;
    const labelProgram = labelBitmap ? link(gl, LABEL_VS, LABEL_FS) : null;
    const uLabelScale = labelProgram ? gl.getUniformLocation(labelProgram, "uScale") : null;
    const labelVao = gl.createVertexArray();
    if (labelBitmap){
        gl.bindVertexArray(labelVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, labelBitmap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // fixed seed: the same objects on every run and every machine
    let seed = 1337;
    const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const objects = Array.from({ length: load.draws }, () => ({
        x: (rand() - 0.5) * 80,
        y: (rand() - 0.5) * 50,
        z: (rand() - 0.5) * 40,
        scale: 0.6 + rand() * 1.6,
        spin: 0.2 + rand() * 1.5,
        red: 0.3 + rand() * 0.7,
        green: 0.3 + rand() * 0.7,
        blue: 0.3 + rand() * 0.7,
    }));

    const projection = new Float32Array(16);
    const view = new Float32Array(16);
    const viewProjection = new Float32Array(16);
    const model = new Float32Array(16);
    view[0] = 1;
    view[5] = 1;
    view[10] = 1;
    view[15] = 1;
    view[14] = -60;

    return {
        resize(width, height){
            canvas.width = Math.max(1, Math.round(width));
            canvas.height = Math.max(1, Math.round(height));
            gl.viewport(0, 0, canvas.width, canvas.height);
            perspective(projection, Math.PI / 2, canvas.width / canvas.height, 0.1, 500);
            multiply(viewProjection, projection, view);
        },

        render(timeMs){
            const seconds = timeMs * 0.001;
            cpuWork(load.cpuIterations);

            gl.enable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);
            gl.clearColor(0.08, 0.09, 0.12, 1);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

            gl.useProgram(meshProgram);
            gl.bindVertexArray(meshVao);
            gl.uniformMatrix4fv(uViewProj, false, viewProjection);
            for (const object of objects){
                modelMatrix(model, object.x, object.y, object.z, seconds * object.spin, object.scale);
                gl.uniformMatrix4fv(uModel, false, model);
                gl.uniform3f(uColor, object.red, object.green, object.blue);
                gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);
            }

            gl.disable(gl.DEPTH_TEST);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(fillProgram);
            gl.bindVertexArray(fillVao);
            gl.uniform1f(uTime, seconds);
            for (let layer = 0; layer < load.overdraw; layer++){
                gl.uniform1f(uLayer, layer);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            }

            if (labelBitmap && labelProgram){
                // at its own pixel size whatever the canvas measures
                gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                gl.useProgram(labelProgram);
                gl.bindVertexArray(labelVao);
                gl.uniform2f(uLabelScale, labelBitmap.width / canvas.width, labelBitmap.height / canvas.height);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }
            gl.bindVertexArray(null);
        },

        lost(){
            return gl.isContextLost();
        },

        destroy(){
            if (!gl.isContextLost()) gl.getExtension("WEBGL_lose_context")?.loseContext();
        },
    };
}

/**
 * @return {number}
 */
export function cpuChecksum(){
    return cpuSink;
}
