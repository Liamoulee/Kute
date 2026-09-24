import { kute } from "../client.js";

/**
 * @return {Promise<void>}
 */
async function showAboutPopup(){
    if (document.querySelector("#aboutPopupHost")) return;

    const [html, logo] = await Promise.all([import("../components/about.html"), import("../components/logo.webp")]);

    const overlay = document.createElement("div");
    overlay.style = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0,0,0,0.75);
        z-index: 9998;
        display: flex;
        justify-content: center;
        align-items: center;
    `;

    const host = document.createElement("div");
    host.id = "aboutPopupHost";
    overlay.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = html.default;

    const logoElement = /** @type {HTMLImageElement|null} */ (shadow.querySelector("#aboutLogo"));
    if (logoElement) logoElement.src = logo.default;
    const version = shadow.querySelector("#aboutVersion");
    if (version) version.textContent = `Version ${kute.version}`;

    for (const link of shadow.querySelectorAll("[data-url]")){
        link.addEventListener("click", () => window.chrome.webview.postMessage(`open-url, ${link.getAttribute("data-url")}`));
    }

    const closeController = new AbortController();

    const close = () => {
        closeController.abort();
        overlay.remove();
    };

    shadow.querySelector("#aboutClose")?.addEventListener("click", close);
    overlay.addEventListener("mousedown", (event) => {
        if (event.target === overlay) close();
    });
    document.addEventListener(
        "keydown",
        (event) => {
            if (event.key === "Escape") close();
        },
        { signal: closeController.signal },
    );

    document.body.append(overlay);
}

kute.showAboutPopup = showAboutPopup;
