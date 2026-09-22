/**
 * The live state of the userscripts the exe runs (src/frontend/host/userscriptRunner.js). The renderer puts the
 * registry on window only while it evaluates the bundle and deletes it again before any page script runs, so this
 * module has to be imported statically from main.js: a dynamic import would come too late.
 * Null with an exe older than the runner, or with userscripts switched off.
 *
 * @type {Registry|null}
 */
export const registry = /** @type {any} */ (window).__kuteUserscripts ?? null;
