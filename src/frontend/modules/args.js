import { kute } from "../client.js";
import { waitForElement } from "../utils.js";

/**
 * action=host-comp&... launch arg
 *
 * @typedef {object} CompHostParams
 * @property {string} mapId map element id or map name
 * @property {string} team1Name
 * @property {string} team2Name
 * @property {string} teamSize "1v1".."4v4" or a raw select value
 * @property {string} [team1Players]
 * @property {string} [team2Players]
 * @property {string} [spectators]
 * @property {string} [classes] json, gun name -> class limit
 * @property {string} [webhook] uri encoded
 * @property {string} [region] short code, see changeRegion
 */

/**
 * @param {CompHostParams} params
 * @return {Promise<void>}
 */
const automateCompHost = async(params) => {
    window.openHostWindow(false, 1);
    await waitForElement(".hostTb0");
    let mapCheckbox = /** @type {HTMLInputElement|null} */ (document.querySelector(`#${params.mapId}`));

    if (!mapCheckbox){
        const allMapNameElements = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".hostMap .hostMapName"));
        const targetNameElement = Array.from(allMapNameElements).find(
            (el) => el.innerText.trim().toLowerCase() === params.mapId.toLowerCase(),
        );
        if (targetNameElement){
            mapCheckbox = /** @type {HTMLInputElement|null} */ (
                targetNameElement.parentElement?.querySelector('input[type="checkbox"]') ?? null
            );
        }
    }

    if (!mapCheckbox) return;

    if (!mapCheckbox.checked) mapCheckbox.click();

    windows[7].switchTab(2);

    /** @type {HTMLInputElement} */
    const team1Input = await waitForElement("#customSnameTeam1");
    team1Input.value = params.team1Name;
    /** @type {HTMLInputElement} */
    const team2Input = await waitForElement("#customSnameTeam2");
    team2Input.value = params.team2Name;

    /** @type {HTMLSelectElement} */
    const teamSizeSelect = await waitForElement("#customStmSize");

    /** @type {Record<string, string>} */
    const teamSizeMap = {
        "1v1": "0",
        "2v2": "1",
        "3v3": "2",
        "4v4": "3",
    };

    if (params.team1Players){
        /** @type {HTMLInputElement} */
        const compRosterT1 = await waitForElement("#compRosterT1");
        compRosterT1.value = params.team1Players;
    }
    if (params.team2Players){
        /** @type {HTMLInputElement} */
        const compRosterT2 = await waitForElement("#compRosterT2");
        compRosterT2.value = params.team2Players;
    }

    if (params.spectators){
        /** @type {HTMLInputElement} */
        const compSpectators = await waitForElement("#compRosterSpecs");
        compSpectators.value = params.spectators;
    }

    /** @type {HTMLInputElement} */
    const customSspecSlots = await waitForElement("#customSspecSlots");
    customSspecSlots.value = "4";

    const gunMap = [
        "ak",
        "sniper",
        "smg",
        "lmg",
        "shotgun",
        "rev",
        "semi",
        "rpg",
        "uzi",
        "runner",
        "deagler",
        "crossbow",
        "famas",
        "blaster",
        "survivor",
        "infiltrator",
    ];

    if (params.classes){
        const classes = JSON.parse(params.classes);
        for (const [gunName, limit] of Object.entries(classes)){
            const id = gunMap.indexOf(gunName);
            /** @type {HTMLInputElement} */
            const element = await waitForElement(`#customSclassLim${id}`);
            element.value = String(limit);
        }
    }

    const finalTeamSize = teamSizeMap[params.teamSize] || params.teamSize;
    teamSizeSelect.value = finalTeamSize;

    if (params.webhook){
        try {
            /** @type {HTMLInputElement} */
            const webhookInput = await waitForElement("#customSwebhook");
            webhookInput.value = decodeURIComponent(params.webhook);
        }
        catch {
            /* */
        }
    }
    window.createPrivateRoom();
};

/**
 * @param {string} region short code (FRA, SV, ...) or a raw region value
 * @return {Promise<void>}
 */
const changeRegion = async(region) => {
    /** @type {Record<string, string>} */
    const regionMap = {
        FRA: "de-fra",
        SV: "us-ca-sv",
        SYD: "au-syd",
        TOK: "jb-hnd",
        SIN: "sgp",
        NY: "us-nj",
        MUM: "as-mb",
        DAL: "us-tx",
        BR: "brz",
        ME: "me-bhn",
    };

    const normalizedRegion = regionMap[region.toUpperCase()] || region;

    window.showWindow(1);

    const selectRoot = /** @type {HTMLSelectElement|null} */ (document.querySelector("select.inputGrey2"));
    if (!selectRoot){
        if (typeof window.setSetting === "function"){
            window.setSetting("defaultRegion", normalizedRegion);
        }
        return;
    }

    const regionValues = Object.values(regionMap);
    const regionSelect =
        Array.from(/** @type {NodeListOf<HTMLSelectElement>} */ (document.querySelectorAll("select.inputGrey2"))).find((select) =>
            Array.from(select.options).some((opt) => regionValues.includes(opt.value)),
        ) || selectRoot;

    if (regionSelect && regionSelect.value !== normalizedRegion){
        const optionIndex = Array.from(regionSelect.options).findIndex((opt) => opt.value === normalizedRegion);
        if (optionIndex !== -1){
            regionSelect.selectedIndex = optionIndex;
            regionSelect.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
        }
    }

    window.showWindow(1);
};

/**
 * @param {string} str
 * @return {Record<string, string>}
 */
const parseQueryString = (str) => {
    const query = str.includes("?") ? str.split("?")[1] : str;
    return Object.fromEntries(new URLSearchParams(query).entries());
};

const pendingParams = sessionStorage.getItem("pendingCompHost");
if (pendingParams){
    sessionStorage.removeItem("pendingCompHost");
    const params = JSON.parse(pendingParams);
    automateCompHost(params);
}

/**
 * startup args, or the ones a second instance forwarded
 *
 * @param {string} args space separated
 * @return {Promise<void>}
 */
kute.parseArgs = async(args) => {
    const argList = args.split(" ");
    for (const arg of argList){
        if (arg.includes("action=host-comp")){
            const params = /** @type {CompHostParams} */ (parseQueryString(arg));
            if (params.region){
                sessionStorage.setItem("pendingCompHost", JSON.stringify(params));
                await changeRegion(params.region);
                window.location.href = "https://krunker.io/";
            }
            else {
                await automateCompHost(params);
            }
        }
    }
};

window.chrome.webview.addEventListener("message", async(event) => {
    if (!event.data?.args) return;
    await kute.parseArgs(event.data.args);
});

