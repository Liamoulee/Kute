import { marked } from "marked";

/**
 * Compares two version strings numerically.
 *
 * @param {string} a
 * @param {string} b
 * @return {number} Negative if a < b, zero if equal, positive if a > b
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
     * Shows the release notes of a version fetched from the GitHub release.
     *
     * @param {string} version
     * @return {Promise<void>}
     */
    async function showChangelogPopup(version){
        const html = await import("../components/changelog.html");
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

        const title = shadow.getElementById("changelogTitle");
        if (title) title.textContent = `kute ${version}`;
        const content = shadow.getElementById("changelogContent");
        if (content) content.textContent = "loading release notes...";
        const closeBtn = shadow.getElementById("closeChangelog");
        if (closeBtn) closeBtn.onclick = () => overlay.remove();

        let markdown = "no release notes found";
        try {
            const res = await fetch(`https://api.github.com/repos/NullDev/Kute/releases/tags/${version}`);
            const data = await res.json();
            markdown = data.body || markdown;
        }
        catch {
            if (content){
                content.innerHTML = `<span style='color:#eb5656'>failed to load release notes. check them out on <a href='https://github.com/NullDev/Kute/releases/tag/${version}' target='_blank' rel='noopener'>github</a></span>`;
            }
            return;
        }

        const htmlContent = await marked.parse(markdown, {
            breaks: true,
            async: true,
        });
        if (content) content.innerHTML = htmlContent;

        // make anchor links point to the release page instead of attempting to scroll to the anchor in the current page (which won't work)
        const releaseUrl = `https://github.com/NullDev/Kute/releases/tag/${version}`;
        for (const a of shadow.querySelectorAll("a")){
            if (a.getAttribute("href")?.startsWith("#")) a.setAttribute("href", releaseUrl + a.getAttribute("href"));
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener");
        }

        overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) overlay.remove();
        });
    }

    const currentVersion = window.kute?.version;
    const lastSeenVersion = window.localStorage.getItem("kute_lastSeenVersion");
    const isNewVersion = semverCompare(currentVersion, lastSeenVersion) > 0;
    window.localStorage.setItem("kute_lastSeenVersion", currentVersion);
    if (window.kute?.settings.data?.showChangelog && lastSeenVersion && currentVersion && isNewVersion){
        await showChangelogPopup(currentVersion);
    }

    // expose this for the manual trigger button in settings
    window.kute.showChangelogPopup = showChangelogPopup;
})();
