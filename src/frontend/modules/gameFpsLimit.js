const nativeRAF = window.requestAnimationFrame;
let nextFrameTime = performance.now();

/**
 * Wraps requestAnimationFrame with a busy-wait limiter driven by the gameFpsLimit setting.
 *
 * @param {FrameRequestCallback} callback
 * @return {number}
 */
window.requestAnimationFrame = function(callback){
    return nativeRAF(function(timestamp){
        const targetFps = window.kute?.settings?.data?.gameFpsLimit ?? 0;

        if (targetFps > 0){
            /** @type {number} */
            let targetInterval;
            if (targetFps > 200) targetInterval = 1000 / (targetFps * 1.0055);
            else targetInterval = 1000 / targetFps;

            while (performance.now() < nextFrameTime){
                // busy wait until the next frame slot
            }

            const now = performance.now();

            if (now - nextFrameTime > targetInterval){
                nextFrameTime = now + targetInterval;
            }
            else nextFrameTime += targetInterval;
        }
        else nextFrameTime = performance.now();

        callback(timestamp);
    });
};

export {};
