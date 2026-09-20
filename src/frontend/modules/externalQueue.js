import { getElement } from "../utils.js";

/** @type {HTMLButtonElement} */
const externalQueue = document.createElement("button");

externalQueue.textContent = "open_in_new";
externalQueue.style = `background-color: #5ce05a;
    color: #ffffff;
    border-radius: 9px;
    padding: 20px 21px;
    font-family: 'Material Icons Outlined';
    cursor: pointer;
    font-size: 20px;
    text-shadow: 2px 2px 0px black !important;
	margin-left: 2px;`;

const origRanked = window.openRankedMenu;
/**
 * Wraps Krunker's openRankedMenu to add the external queue button to its footer.
 */
window.openRankedMenu = () => {
    origRanked();
    const footer = getElement(".footer-controls");
    const lastChild = footer.lastElementChild;
    footer.insertBefore(externalQueue, lastChild);
};

/**
 * Opens the ranked queue in a separate popup window, passing region and auth token to it.
 */
function openExtQueue(){
    const screenWidth = window.screen.width;
    const screenHeight = window.screen.height;
    const windowWidth = 850;
    const windowHeight = 350;
    const left = (screenWidth - windowWidth) / 2;
    const top = (screenHeight - windowHeight) / 2;
    /** @type {(Window & { info?: { allRegions: boolean, token: string, region: string, sound: string } })|null} */
    const queueWindow = window.open(
        "about:blank",
        "_blank",
        `width=${windowWidth},height=${windowHeight},left=${left},top=${top}`,
    );
    if (!queueWindow) return;

    let region = (getElement(".region-indicator").textContent ?? "").split(": ")[1];
    switch (region){
        case "North America":
            region = "na";
            break;
        case "Europe":
            region = "eu";
            break;
        case "Asia":
            region = "as";
            break;
        default:
            break;
    }
    let token = localStorage.getItem("__FRVR_auth_access_token") ?? "";
    token = token.replace(/"/g, "");
    token = token.replace("/", "");
    const allRegions = localStorage.getItem("s_rankedAllRegions") === "true";
    // the window is about:blank, so it cannot load anything of ours: markup, script and sound get handed over.
    // all three only get touched when somebody opens the queue
    Promise.all([
        import("../components/queue/index.html"),
        import("popup-script:../components/queue/queue.js"),
        import("../components/queue/match-found.ogg"),
    ]).then(([html, code, sound]) => {
        queueWindow.info = { allRegions, token, region, sound: sound.default };

        const doc = new DOMParser().parseFromString(html.default, "text/html");
        queueWindow.document.head.append(...Array.from(doc.head.children, (child) => queueWindow.document.importNode(child, true)));
        queueWindow.document.body.append(...Array.from(doc.body.children, (child) => queueWindow.document.importNode(child, true)));

        // last, the script looks its elements up as it starts. made by the popup's own document so it runs there
        const script = queueWindow.document.createElement("script");
        script.textContent = code.default;
        queueWindow.document.head.append(script);
    });
}

externalQueue.onclick = openExtQueue;
