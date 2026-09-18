/**
 * Wraps a prototype method. The wrapper receives the call arguments and the original method.
 * If the wrapper returns undefined the original method is called with the same arguments.
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
 * Resolves once an element matching the selector exists in the document.
 *
 * While it waits it observes the whole body and looks the selector up on every change anywhere in the page. That
 * is fine for the second it normally takes, and expensive forever: an element that never shows up (a Krunker
 * update renamed it) would leave that running through every match. So it gives up after timeoutMs and rejects,
 * which also gets the missing element reported (errorReports.js).
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
 * document.querySelector that throws instead of returning null, for elements that must exist.
 *
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
 * getElement typed for form controls.
 *
 * @param {string} selector
 * @param {ParentNode} [root]
 * @return {HTMLInputElement}
 */
export const getInput = (selector, root = document) => getElement(selector, root);

/**
 * Checks whether the game is currently in a comp (tournament) match.
 *
 * @return {boolean}
 */
export const checkCompMode = () => {
    if (document.querySelector(".cmpTmHed")){
        return true;
    }
    return false;
};

/**
 * Posts a message to the host and resolves with the reply's field.
 *
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
