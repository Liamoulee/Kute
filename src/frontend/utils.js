/**
 * Wraps a prototype method. The wrapper receives the call arguments and the original method.
 * If the wrapper returns undefined the original method is called with the same arguments.
 *
 * @param {{ prototype: Record<string, any> }} target
 * @param {string} method
 * @param {(this: any, args: any[], original: Function) => any} wrapper
 */
window.hook = (target, method, wrapper) => {
    const original = target.prototype[method];
    target.prototype[method] = function(...args){
        const result = wrapper.call(this, args, original);
        return result === undefined ? original.apply(this, args) : result;
    };
};

/**
 * Resolves once an element matching the selector exists in the document.
 *
 * @param {string} selector
 * @return {Promise<Element>}
 */
window.waitForElement = (selector) => {
    return new Promise((resolve) => {
        if (document.querySelector(selector)) return resolve(document.querySelector(selector));

        const observer = new MutationObserver(() => {
            if (document.querySelector(selector)){
                resolve(document.querySelector(selector));
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
};

/**
 * Checks whether the game is currently in a comp (tournament) match.
 *
 * @return {boolean}
 */
window.checkCompMode = () => {
    if (document.querySelector(".cmpTmHed")){
        return true;
    }
    return false;
};
