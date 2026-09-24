/**
 * Live userscript state from the runner. Only on window during bundle eval, so import statically.
 * Null on an old exe or with userscripts off.
 *
 * @type {Registry|null}
 */
export const registry = /** @type {any} */ (window).__kuteUserscripts ?? null;
