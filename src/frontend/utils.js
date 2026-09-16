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
 * @template {Element} [T=HTMLElement]
 * @param {string} selector
 * @return {Promise<T>}
 */
export const waitForElement = (selector) => {
    return new Promise((resolve) => {
        const existing = document.querySelector(selector);
        if (existing){
            resolve(/** @type {T} */ (existing));
            return;
        }

        const observer = new MutationObserver(() => {
            const element = document.querySelector(selector);
            if (element){
                resolve(/** @type {T} */ (element));
                observer.disconnect();
            }
        });
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

