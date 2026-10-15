// ==UserScript==
// @name         Quick Sell by Rarity
// @author       aashten
// @version      1.0.0
// @description  Quick sells every item of one rarity in your inventory at once, after a preview and a confirmation
// @run-at       document-end
// @license      MIT
// ==/UserScript==

// shipped with kute as an example of a userscript that talks to krunker's own market api, the same requests the
// game's quick sell window makes: GET market/inventory, POST market/quick-sell per stack, item data from data/skins.
// nothing is sold before the preview dialog and the confirm dialog were both accepted. a button in the market
// window's inventory tab opens it. `this.settings` holds the preselected rarity (sel), `this._css` adds the button's
// hover style, `this.unload` removes button, observer, style and dialogs so the manager can switch it off live

const API = "https://gapi.svc.krunker.io";
// krunker's rarity table: name, kr per quick sold item
const RARITIES = [
    ["Uncommon", 1], ["Rare", 3], ["Epic", 10], ["Legendary", 100], ["Relic", 500], ["Contraband", 2500], ["Unobtainable", 10000],
];
const PAUSE_MS = 250;

const log = this._console;

let rarityName = RARITIES[0][0];
/** @type {Promise<any[]>|null} */
let skinsPromise = null;
/** @type {(() => void)|null} closes whatever dialog is open */
let closeDialog = null;
let busy = false;

// data/skins is jsonpack (sapienlab/jsonpack, MIT): "strings^ints^floats^structure", the game unpacks it the same way
const unpackJson = (/** @type {string} */ packed) => {
    const [strings, ints, floats, structure] = packed.split("^");
    const decode = (/** @type {string} */ text) => text.replace(/\+|%2B|%7C|%5E|%25/g, (match) => ({ "+": " ", "%2B": "+", "%7C": "|", "%5E": "^", "%25": "%" })[match] ?? match);
    /** @type {any[]} */
    const dictionary = [];
    if (strings !== "") for (const text of strings.split("|")) dictionary.push(decode(text));
    if (ints !== "") for (const text of ints.split("|")) dictionary.push(Number.parseInt(text, 36));
    if (floats !== "") for (const text of floats.split("|")) dictionary.push(Number.parseFloat(text));

    /** @type {(string|number)[]} */
    const tokens = [];
    let word = "";
    for (const char of structure){
        if (char === "|" || char === "$" || char === "@" || char === "]"){
            if (word){
                tokens.push(Number.parseInt(word, 36));
                word = "";
            }
            if (char !== "|") tokens.push(char);
        }
        else word += char;
    }
    if (word) tokens.push(Number.parseInt(word, 36));

    const SPECIAL = /** @type {Record<number, any>} */ ({ [-1]: true, [-2]: false, [-3]: null, [-4]: "", [-5]: undefined });
    let position = 0;
    const atom = (/** @type {string|number} */ token) => (typeof token === "number" && token < 0 ? SPECIAL[token] : dictionary[/** @type {number} */ (token)]);
    const nested = () => tokens[position] === "@" || tokens[position] === "$";
    /** @return {any} */
    const parse = () => {
        const token = tokens[position++];
        if (token === "@"){
            const list = [];
            while (position < tokens.length && tokens[position] !== "]") list.push(nested() ? parse() : atom(tokens[position++]));
            position++;
            return list;
        }
        if (token === "$"){
            /** @type {Record<string, any>} */
            const object = {};
            while (position < tokens.length && tokens[position] !== "]"){
                const key = tokens[position++];
                object[key === -4 ? "" : dictionary[/** @type {number} */ (key)]] = nested() ? parse() : atom(tokens[position++]);
            }
            position++;
            return object;
        }
        throw new TypeError(`bad token ${token}`);
    };
    return parse();
};

const token = async() => {
    try {
        const fresh = await window.FRVR?.auth?.getFreshAccessToken?.();
        if (fresh) return fresh;
    }
    catch {
        // fall through to the stored token
    }
    return String(localStorage.getItem("__FRVR_auth_access_token") ?? "").trim().replace(/^"|"$/g, "");
};

/**
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @return {Promise<any>} the api's data field
 */
const request = async(method, path, body) => {
    const headers = /** @type {Record<string, string>} */ ({ Accept: "application/json", Authorization: `Bearer ${await token()}` });
    if (body){
        headers["Content-Type"] = "application/json";
        headers["X-Idempotency-Key"] = crypto.randomUUID();
    }
    const response = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(typeof payload.error === "string" ? payload.error : payload.error?.message ?? `${method} ${path} failed (${response.status})`);
    return payload.data ?? payload;
};

const skins = () => {
    skinsPromise ??= fetch(`${API}/data/skins`).then((response) => response.text()).then(unpackJson).catch((error) => {
        skinsPromise = null;
        throw error;
    });
    return skinsPromise;
};

// the game's own rule (its quick sell window): no sale for black market only, opensea and noQuickSell items,
// the value comes from the rarity, minQuickSell makes it 5 and qsKR overrides it
const quickSellKr = (/** @type {any} */ skin) => {
    if (!skin || (skin.noSale && skin.blackM) || skin.opensea || skin.noQuickSell) return 0;
    let kr = RARITIES[skin.rarity]?.[1] ?? 0;
    if (skin.minQuickSell && kr) kr = 5;
    if (skin.qsKR && kr) kr = skin.qsKR;
    return kr;
};

/**
 * @typedef {object} Stack one inventory record: item index, instance id, count, the item's name and kr per item
 * @property {number} i
 * @property {number} sid
 * @property {number} cnt
 * @property {string} name
 * @property {number} kr
 */

/** @return {Promise<Stack[]>} */
const loadStacks = async(/** @type {number} */ rarity) => {
    const [inventory, definitions] = await Promise.all([request("GET", "/market/inventory"), skins()]);
    const entries = Array.isArray(inventory) ? inventory : inventory?.items ?? [];
    /** @type {Stack[]} */
    const stacks = [];
    for (const entry of entries){
        const count = Number(entry.cnt ?? 1);
        const skin = definitions[Number(entry.i)];
        const kr = quickSellKr(skin);
        if (count > 0 && kr > 0 && skin.rarity === rarity) stacks.push({ i: Number(entry.i), sid: Number(entry.sid), cnt: count, name: String(skin.name ?? `Item ${entry.i}`), kr });
    }
    return stacks;
};

const DIALOG_CSS = `
.overlay { position: fixed; inset: 0; z-index: 2147483000; display: flex; justify-content: center; align-items: center; background: rgba(0, 0, 0, 0.75); }
.popup { box-sizing: border-box; width: 520px; max-width: 90vw; padding: 2em 2.4em 1.6em 2.4em; background: #1e1e1e; color: #fff; border-radius: 14px; box-shadow: 0 8px 48px #000c; font-family: Consolas, monospace; font-size: 14px; text-align: center; }
h2 { margin: 0 0 0.8em 0; font-size: 1.6em; letter-spacing: 1px; color: #35e0e8; }
p { margin: 0 0 0.9em 0; line-height: 1.6; color: #ccc; }
.muted { color: #888; }
.bad { color: #ff8a8a; }
select { width: 100%; padding: 0.5em; border: 1px solid #444; border-radius: 6px; background: #181818; color: #fff; font: inherit; }
.list { max-height: 180px; margin: 0.6em 0; padding: 0.5em 0.8em; overflow-y: auto; border-radius: 8px; background: #181818; text-align: left; line-height: 1.7; }
.actions { display: flex; gap: 0.7em; margin-top: 1.4em; }
.button { flex: 1 1 0; padding: 0.7em 0.5em; border-radius: 8px; background: #2a2a2a; color: #999; cursor: pointer; user-select: none; }
.button:hover { background: #333; }
.button.primary { background: #1b5e63; color: #fff; }
.button.primary:hover { background: #23777d; }
.button.disabled { opacity: 0.4; pointer-events: none; }
`;

/**
 * Kute's confirm popup look, with a body the caller fills. Escape and a click outside count as the first button.
 *
 * @param {string} title
 * @param {{ label: string, primary?: boolean, onClick: () => void }[]} buttons
 * @return {{ body: HTMLElement, buttons: HTMLElement[], close: () => void }}
 */
const openDialog = (title, buttons) => {
    closeDialog?.();
    const overlay = document.createElement("div");
    const shadow = overlay.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = DIALOG_CSS;
    const box = document.createElement("div");
    box.className = "overlay";
    const popup = document.createElement("div");
    popup.className = "popup";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const body = document.createElement("div");
    const actions = document.createElement("div");
    actions.className = "actions";
    popup.append(heading, body, actions);
    box.append(popup);
    shadow.append(style, box);

    const controller = new AbortController();
    const close = () => {
        controller.abort();
        overlay.remove();
        if (closeDialog === close) closeDialog = null;
    };
    const elements = buttons.map(({ label, primary, onClick }) => {
        const button = document.createElement("div");
        button.className = `button${primary ? " primary" : ""}`;
        button.textContent = label;
        button.onclick = onClick;
        actions.append(button);
        return button;
    });
    box.addEventListener("mousedown", (event) => {
        if (event.target === box) buttons[0].onClick();
    });
    // krunker binds its keys on document, the dialog must not type into the game
    for (const type of ["keydown", "keyup", "keypress"]){
        shadow.addEventListener(type, (event) => event.stopPropagation(), { signal: controller.signal });
    }
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        buttons[0].onClick();
    }, { capture: true, signal: controller.signal });
    document.body.append(overlay);
    closeDialog = close;
    return { body, buttons: elements, close };
};

const paragraph = (/** @type {string} */ text, /** @type {string} */ className = "") => {
    const p = document.createElement("p");
    p.textContent = text;
    if (className) p.className = className;
    return p;
};

const sell = async(/** @type {Stack[]} */ stacks, /** @type {string} */ name) => {
    const total = stacks.reduce((sum, stack) => sum + stack.cnt, 0);
    const dialog = openDialog("Quick Sell by Rarity", [{ label: "Selling...", onClick: () => undefined }]);
    dialog.buttons[0].classList.add("disabled");
    const progress = paragraph(`Selling ${total} ${name} items...`);
    dialog.body.append(progress);

    let soldItems = 0;
    let soldKr = 0;
    let gotFunds = false;
    /** @type {string[]} */
    const failed = [];
    for (const [index, stack] of stacks.entries()){
        progress.textContent = `Selling ${name} items, stack ${index + 1} of ${stacks.length}...`;
        try {
            // the game's quick sell window: amount 2 is "all" of a stack, amount 0 one item by its instance id
            const body = stack.cnt > 1
                ? { item_id: stack.i, action: 0, amount: 2 }
                : { item_id: stack.i, action: 0, amount: 0, skin_id: stack.sid };
            const result = await request("POST", "/market/quick-sell", body);
            soldItems += Number(result?.count ?? stack.cnt);
            if (typeof result?.funds === "number"){
                gotFunds = true;
                soldKr += result.funds;
            }
            else soldKr += stack.kr * stack.cnt;
        }
        catch (error){
            failed.push(`${stack.name} x${stack.cnt}: ${error instanceof Error ? error.message : String(error)}`);
            log.warn("[quick sell] failed:", stack, error);
        }
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }

    const summary = openDialog("Quick sell done", [{ label: "Close", primary: true, onClick: () => summary.close() }]);
    summary.body.append(paragraph(`Sold ${soldItems} of ${total} ${name} items for ${soldKr.toLocaleString()} KR${gotFunds ? "" : " (estimated)"}.`));
    if (failed.length){
        summary.body.append(paragraph(`${failed.length} stack${failed.length === 1 ? "" : "s"} could not be sold:`, "bad"));
        const list = document.createElement("div");
        list.className = "list";
        for (const line of failed) list.append(paragraph(line, "bad"));
        summary.body.append(list);
    }
    summary.body.append(paragraph("Open the inventory again to see the new KR balance.", "muted"));
    log.log(`[quick sell] sold ${soldItems}/${total} ${name} items, ${soldKr} KR, ${failed.length} failed`);
};

const confirmSale = (/** @type {Stack[]} */ stacks, /** @type {string} */ name) => {
    const total = stacks.reduce((sum, stack) => sum + stack.cnt, 0);
    const kr = stacks.reduce((sum, stack) => sum + stack.kr * stack.cnt, 0);
    const dialog = openDialog("Sell them all?", [
        { label: "Keep them", primary: true, onClick: () => {
            dialog.close();
            busy = false;
        } },
        { label: `Sell ${total} item${total === 1 ? "" : "s"}`, onClick: () => {
            dialog.close();
            sell(stacks, name).catch((error) => log.error("[quick sell]", error)).finally(() => {
                busy = false;
            });
        } },
    ]);
    dialog.body.append(
        paragraph(`${total} ${name} item${total === 1 ? "" : "s"} in ${stacks.length} stack${stacks.length === 1 ? "" : "s"} will be quick sold for ${kr.toLocaleString()} KR.`),
        paragraph("Quick selling cannot be undone. Items the game marks as not quick sellable are skipped, the rest goes for the game's own quick sell price.", "muted"),
    );
};

const openPicker = () => {
    if (busy) return;
    busy = true;
    const dialog = openDialog("Quick Sell by Rarity", [
        { label: "Cancel", primary: true, onClick: () => {
            dialog.close();
            busy = false;
        } },
        { label: "Continue", onClick: () => undefined },
    ]);
    const [, next] = dialog.buttons;
    next.classList.add("disabled");

    const select = document.createElement("select");
    for (const [name] of RARITIES){
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        option.selected = name === rarityName;
        select.append(option);
    }
    const status = paragraph("Loading your inventory...", "muted");
    const list = document.createElement("div");
    list.className = "list";
    list.hidden = true;
    dialog.body.append(paragraph("Every quick sellable item of this rarity gets sold, like pressing the game's quick sell on each of them."), select, status, list);

    /** @type {Stack[]} */
    let stacks = [];
    let loading = 0;
    const refresh = async() => {
        const run = ++loading;
        const rarity = RARITIES.findIndex(([name]) => name === select.value);
        next.classList.add("disabled");
        list.hidden = true;
        list.textContent = "";
        status.className = "muted";
        status.textContent = "Loading your inventory...";
        try {
            const loaded = await loadStacks(rarity);
            if (run !== loading) return;
            stacks = loaded;
        }
        catch (error){
            if (run !== loading) return;
            status.className = "bad";
            status.textContent = `Could not load the inventory: ${error instanceof Error ? error.message : String(error)}. Are you logged in?`;
            return;
        }
        const total = stacks.reduce((sum, stack) => sum + stack.cnt, 0);
        const kr = stacks.reduce((sum, stack) => sum + stack.kr * stack.cnt, 0);
        if (!stacks.length){
            status.textContent = `No quick sellable ${select.value} items in your inventory.`;
            return;
        }
        status.className = "";
        status.textContent = `${total} item${total === 1 ? "" : "s"} in ${stacks.length} stack${stacks.length === 1 ? "" : "s"}, ${kr.toLocaleString()} KR`;
        list.textContent = "";
        for (const stack of [...stacks].sort((a, b) => a.name.localeCompare(b.name))){
            const line = document.createElement("div");
            line.textContent = `${stack.name}${stack.cnt > 1 ? ` x${stack.cnt}` : ""}`;
            list.append(line);
        }
        list.hidden = false;
        next.classList.remove("disabled");
    };
    select.onchange = () => refresh();
    next.onclick = () => {
        if (!stacks.length) return;
        confirmSale(stacks, select.value);
    };
    refresh();
};

// a button next to "Reset Filters" in the market window's inventory tab. svelte rebuilds that header on every tab
// switch, so it is added again whenever the popup holder changes (popups only change in the menu, never mid match)
const BUTTON_CLASS = "kuteQuickSellButton";
this._css(`.${BUTTON_CLASS}:hover { background: #777 !important; }`, BUTTON_CLASS, true);

const mountButton = () => {
    const controls = document.querySelector(".market-container .inventory-filter .filter-controls");
    // the browse tab has the same filter header
    const onInventory = /inventory/i.test(document.querySelector(".market-container .tabs-container .tab-active")?.textContent ?? "");
    if (!controls || !onInventory){
        document.querySelector(`.${BUTTON_CLASS}`)?.remove();
        return;
    }
    if (controls.querySelector(`.${BUTTON_CLASS}`)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.textContent = "Quick Sell by Rarity";
    // the game's own filter buttons: 12px GameFont, #666, radius 4, 6px 12px
    button.style.cssText = "font: 12px GameFont; background: #666; color: #fff; border: 0; border-radius: 4px; padding: 6px 12px; margin-right: 8px; cursor: pointer;";
    button.onclick = () => openPicker();
    controls.prepend(button);
};
const popupHolder = document.getElementById("popupHolder");
const observer = new MutationObserver(mountButton);
if (popupHolder) observer.observe(popupHolder, { childList: true, subtree: true });
else log.warn("[quick sell] #popupHolder not found, is this krunker?");
mountButton();

this.settings = {
    rarity: {
        title: "Rarity",
        desc: "Preselected in the dialog, you can still change it there",
        type: "sel",
        value: rarityName,
        opts: RARITIES.map(([name]) => name),
        changed(/** @type {string} */ value){
            rarityName = value;
        },
    },
};

this.unload = () => {
    observer.disconnect();
    document.querySelector(`.${BUTTON_CLASS}`)?.remove();
    this._css("", BUTTON_CLASS, false);
    closeDialog?.();
    busy = false;
};
