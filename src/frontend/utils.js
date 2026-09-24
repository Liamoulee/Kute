/**
 * wraps a prototype method, returning undefined from the wrapper calls the original
 *
 * @param {{ prototype: Record<string, any> }} target
 * @param {string} method
 * @param {(this: any, args: any[], original: Function) => any} wrapper
 */
export const hook = (target, method, wrapper) => {
    const original = target.prototype[method];
    /**
     * @this {any}
     * @param {...any} args
     */
    target.prototype[method] = function(...args){
        const result = wrapper.call(this, args, original);
        return result === undefined ? original.apply(this, args) : result;
    };
};

/**
 * resolves once the selector matches. rejects after timeoutMs, a body observer must not run forever
 *
 * @template {Element} [T=HTMLElement]
 * @param {string} selector
 * @param {number} [timeoutMs]
 * @return {Promise<T>}
 */
export const waitForElement = (selector, timeoutMs = 30000) => {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(selector);
        if (existing){
            resolve(/** @type {T} */ (existing));
            return;
        }

        const pending = { timer: 0 };
        const observer = new MutationObserver(() => {
            const element = document.querySelector(selector);
            if (element){
                clearTimeout(pending.timer);
                observer.disconnect();
                resolve(/** @type {T} */ (element));
            }
        });
        pending.timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`element never showed up: ${selector}`));
        }, timeoutMs);
        observer.observe(document.body, { childList: true, subtree: true });
    });
};

/**
 * @template {Element} [T=HTMLElement]
 * @param {string} selector
 * @param {ParentNode} [root]
 * @return {T}
 */
export const getElement = (selector, root = document) => {
    const element = root.querySelector(selector);
    if (!element) throw new Error(`element not found: ${selector}`);
    return /** @type {T} */ (element);
};

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @return {HTMLInputElement}
 */
export const getInput = (selector, root = document) => getElement(selector, root);

/**
 * @return {boolean}
 */
export const checkCompMode = () => {
    if (document.querySelector(".cmpTmHed")){
        return true;
    }
    return false;
};

/**
 * @param {string} message
 * @param {string} key
 * @param {number} [timeoutMs]
 * @return {Promise<any>} null when the host does not answer (an older exe)
 */
export function request(message, key, timeoutMs = 2000){
    return new Promise((resolve) => {
        const pending = { timer: 0 };
        /**
         * @param {MessageEvent} event
         */
        const handler = (event) => {
            if (event.data?.[key] === undefined) return;
            clearTimeout(pending.timer);
            window.chrome.webview.removeEventListener("message", handler);
            resolve(event.data[key]);
        };
        pending.timer = setTimeout(() => {
            window.chrome.webview.removeEventListener("message", handler);
            resolve(null);
        }, timeoutMs);
        window.chrome.webview.addEventListener("message", handler);
        window.chrome.webview.postMessage(message);
    });
}
