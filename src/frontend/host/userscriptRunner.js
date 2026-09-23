/**
 * @typedef {object} HostScript What the host hands over per script
 * @property {string} key "file.js" or "social/file.js"
 * @property {string} group
 * @property {string} file
 * @property {boolean} enabled
 * @property {"document-start"|"document-end"} runAt
 * @property {number} priority
 * @property {Record<string, string>} meta
 * @property {Record<string, any>} prefs
 * @property {Function} [run] The compiled script, absent when it did not compile
 * @property {string} [compileError]
 */

/**
 * @typedef {object} ScriptSetting Crankshaft's setting shape
 * @property {string} title
 * @property {string} [desc]
 * @property {string} type bool, num, sel, color, text, keybind
 * @property {any} value
 * @property {(value: any) => void} changed
 * @property {Array<string|number>} [opts]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 */

/**
 * @typedef {object} ScriptEntry The live state of one script, what the manager shows
 * @property {string} key
 * @property {"idle"|"waiting"|"running"|"error"|"stopped"} state
 * @property {string} error
 * @property {Record<string, ScriptSetting>|null} settings
 * @property {boolean} canUnload
 * @property {boolean} tainted It failed halfway (while running or unloading): whatever it set up may still be there,
 *     so it only runs again after a page refresh
 * @property {Record<string, string>} meta
 * @property {() => void} start
 * @property {() => boolean} stop false when the script could not clean up (no unload, or unload threw), a refresh
 *     is then needed
 * @property {(key: string, value: any) => boolean} setPref
 */

/**
 * @typedef {object} Registry Shared with the bundle
 * @property {ScriptEntry[]} [entries]
 * @property {() => void} [onChange] Set by the bundle
 */

// eslint-disable-next-line no-unused-vars
function runUserscripts(/** @type {HostScript[]} */ scripts, /** @type {Registry|null} */ registry){
    // Krunker replaces the console methods later on, keep the real ones for the scripts (Crankshaft's _console)
    const nativeConsole = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        info: console.info.bind(console),
        debug: console.debug.bind(console),
    };

    /** @type {Map<string, HTMLStyleElement>} */
    const insertedCss = new Map();

    /**
     * Crankshaft's _css: toggles a <style> by identifier.
     *
     * @param {string} css
     * @param {string} identifier
     * @param {boolean|"toggle"} [value]
     */
    const toggleCss = (css, identifier, value = "toggle") => {
        const existing = insertedCss.get(identifier);
        const on = value === "toggle" ? !existing : value;
        if (on && !existing){
            const style = document.createElement("style");
            style.dataset.kuteUserscript = identifier;
            style.textContent = css;
            (document.head ?? document.documentElement).append(style);
            insertedCss.set(identifier, style);
        }
        else if (!on && existing){
            existing.remove();
            insertedCss.delete(identifier);
        }
    };

    const notify = () => {
        try {
            registry?.onChange?.();
        }
        catch {
            // the manager's problem, not the script's
        }
    };

    /**
     * idkr settings -> Crankshaft's shape, so the manager only knows one.
     *
     * @param {Record<string, any>} idkrSettings
     * @return {Record<string, ScriptSetting>}
     */
    const fromIdkr = (idkrSettings) => {
        /** @type {Record<string, ScriptSetting>} */
        const settings = {};
        const types = /** @type {Record<string, string>} */ ({ checkbox: "bool", slider: "num", select: "sel", text: "text", color: "color" });
        for (const [key, setting] of Object.entries(idkrSettings ?? {})){
            if (!setting || !types[setting.type]) continue;
            settings[key] = {
                title: String(setting.name ?? key),
                desc: setting.info,
                type: types[setting.type],
                value: setting.val,
                opts: setting.options ? Object.keys(setting.options) : undefined,
                min: setting.min,
                max: setting.max,
                step: setting.step,
                changed(/** @type {any} */ value){
                    setting.val = value;
                    setting.set?.(value, false);
                },
            };
        }
        return settings;
    };

    /**
     * @param {any} value
     * @return {value is Record<string, ScriptSetting>}
     */
    const isSettings = (value) => Boolean(value) && typeof value === "object" && Object.keys(value).length > 0;

    /**
     * @param {HostScript} script
     * @return {ScriptEntry}
     */
    const createEntry = (script) => {
        /** @type {Function|null} */
        let unload = null;
        /** @type {(() => void)|null} the DOMContentLoaded start a stop has to take back */
        let pendingStart = null;

        /** @type {ScriptEntry} */
        const entry = {
            key: script.key,
            state: "idle",
            error: script.compileError ?? "",
            settings: null,
            canUnload: false,
            tainted: false,
            meta: script.meta,
            start: () => undefined,
            stop: () => false,
            setPref(key, value){
                const setting = entry.settings?.[key];
                if (!setting || typeof setting.changed !== "function") return false;
                try {
                    setting.value = value;
                    setting.changed(value);
                    // a stop and start in this page applies what the player chose last, not what was saved at load
                    script.prefs = { ...script.prefs, [key]: value };
                    return true;
                }
                catch (error){
                    nativeConsole.error(`[kute] userscript ${script.file}, setting ${key}:`, error);
                    return false;
                }
            },
        };

        /**
         * @param {unknown} error
         */
        const fail = (error) => {
            entry.state = "error";
            entry.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            nativeConsole.error(`[kute] userscript ${script.file} failed:`, error);
        };

        const execute = () => {
            if (!script.run) return;
            const context = { _console: nativeConsole, _css: toggleCss, settings: {}, unload: /** @type {any} */ (false) };
            const module = { exports: /** @type {any} */ ({}) };
            try {
                const returned = script.run.call(context, module, module.exports);
                const exported = returned && typeof returned === "object" ? returned : context;
                const idkrOld = typeof module.exports?.run === "function" ? module.exports : null;

                if (exported.config?.apiversion === "1.0" && typeof exported.load === "function"){
                    entry.settings = fromIdkr(exported.config.settings);
                    if (exported.meta && !script.meta.name) entry.meta = { ...script.meta, ...exported.meta };
                    exported.load();
                    unload = typeof exported.unload === "function" ? exported.unload.bind(exported) : null;
                }
                else if (idkrOld){
                    entry.settings = fromIdkr(idkrOld.settings);
                    idkrOld.run.call(context);
                }
                else {
                    entry.settings = isSettings(exported.settings) ? exported.settings : null;
                    // bound: an unload(){ this.x } written as a method needs its object, called bare it loses it
                    unload = typeof exported.unload === "function" ? exported.unload.bind(exported) : null;
                }
                entry.canUnload = Boolean(unload);
                entry.state = "running";

                // saved values, applied the way Crankshaft does: only of the same type, only when they differ
                for (const [key, value] of Object.entries(script.prefs ?? {})){
                    const setting = entry.settings?.[key];
                    if (setting && typeof setting.value === typeof value && JSON.stringify(setting.value) !== JSON.stringify(value)){
                        entry.setPref(key, value);
                    }
                }
            }
            catch (error){
                fail(error);
                // it may have set up half of what it does, running it again would do that part twice
                entry.tainted = true;
            }
            notify();
        };

        entry.start = () => {
            if (entry.state === "running" || entry.state === "waiting" || entry.tainted || !script.run) return;
            if (script.runAt === "document-end" && document.readyState === "loading"){
                entry.state = "waiting";
                pendingStart = () => {
                    pendingStart = null;
                    entry.state = "idle";
                    entry.start();
                };
                document.addEventListener("DOMContentLoaded", pendingStart, { once: true });
                return;
            }
            execute();
        };

        entry.stop = () => {
            if (entry.state === "waiting" && pendingStart){
                // never ran, so there is nothing to clean up
                document.removeEventListener("DOMContentLoaded", pendingStart);
                pendingStart = null;
                entry.state = "stopped";
                notify();
                return true;
            }
            if (entry.state !== "running") return !entry.tainted;
            if (!unload) return false;
            try {
                unload();
                entry.state = "stopped";
            }
            catch (error){
                fail(error);
                entry.error += " (while unloading, refresh the page to clean up)";
                entry.tainted = true;
                notify();
                return false;
            }
            notify();
            return true;
        };

        return entry;
    };

    const entries = scripts
        .map((script, index) => ({ script, index }))
        // higher priority first, then the folder order
        .sort((a, b) => (b.script.priority - a.script.priority) || (a.index - b.index))
        .map(({ script }) => ({ script, entry: createEntry(script) }));

    if (registry) registry.entries = entries.map(({ entry }) => entry);
    for (const { script, entry } of entries){
        if (script.compileError){
            entry.state = "error";
            nativeConsole.error(`[kute] userscript ${script.file} does not compile: ${script.compileError}`);
        }
        else if (script.enabled) entry.start();
    }
    notify();
}
