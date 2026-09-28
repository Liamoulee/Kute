import { marked } from "marked";
import { kute } from "../client.js";

/**
 * @param {string} a
 * @param {string} b
 * @return {number}
 */
function semverCompare(a, b){
    return a.localeCompare(b, undefined, {
        numeric: true,
        sensitivity: "case",
        caseFirst: "upper",
    });
}

(async() => {
    /**
     * @param {string} version
     * @return {Promise<void>}
     */
    async function showChangelogPopup(version){
        const [html, logo] = await Promise.all([import("../components/changelog.html"), import("../components/logo.webp")]);
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
        document.body.append(overlay);

        const host = document.createElement("div");
        host.id = "changelogPopupHost";
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        const container = document.createElement("div");
        container.innerHTML = html.default;

        while (container.firstChild) shadow.append(container.firstChild);

        const releaseUrl = `https://github.com/NullDev/Kute/releases/tag/${version}`;
        const logoImage = /** @type {HTMLImageElement|null} */ (shadow.getElementById("changelogLogo"));
        if (logoImage) logoImage.src = logo.default;
        const versionLabel = shadow.getElementById("changelogVersion");
        if (versionLabel) versionLabel.textContent = version;
        const content = shadow.getElementById("changelogContent");
        if (content) content.textContent = "Loading release notes...";

        const controller = new AbortController();
        const close = () => {
            controller.abort();
            overlay.remove();
        };
        for (const id of ["changelogClose", "changelogDone"]){
            const button = shadow.getElementById(id);
            if (button) button.onclick = close;
        }
        const github = shadow.getElementById("changelogGithub");
        if (github) github.onclick = () => window.chrome.webview.postMessage(`open-url, ${releaseUrl}`);
        overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) close();
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                close();
            },
            { signal: controller.signal, capture: true },
        );

        let markdown = "No release notes found.";
        try {
            const res = await fetch(`https://api.github.com/repos/NullDev/Kute/releases/tags/${version}`);
            const data = await res.json();
            markdown = data.body || markdown;
        }
        catch {
            if (content) content.innerHTML = "<span id='changelogError'>Could not load the release notes. View them on GitHub instead.</span>";
            return;
        }

        const htmlContent = await marked.parse(markdown, {
            breaks: true,
            async: true,
        });
        if (content) content.innerHTML = htmlContent;

        // anchors can't scroll in here, point them at the release page
        for (const a of shadow.querySelectorAll("a")){
            if (a.getAttribute("href")?.startsWith("#")) a.setAttribute("href", releaseUrl + a.getAttribute("href"));
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener");
        }
    }

    const currentVersion = kute?.version;
    const lastSeenVersion = window.localStorage.getItem("kute_lastSeenVersion");
    const isNewVersion = lastSeenVersion !== null && semverCompare(currentVersion, lastSeenVersion) > 0;
    window.localStorage.setItem("kute_lastSeenVersion", currentVersion);
    if (kute?.settings.data?.showChangelog && lastSeenVersion && currentVersion && isNewVersion){
        await showChangelogPopup(currentVersion);
    }

    kute.showChangelogPopup = showChangelogPopup;
})();
