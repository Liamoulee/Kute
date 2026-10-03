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

const REPO_API = "https://api.github.com/repos/NullDev/Kute";

/** @type {Promise<string[]>|null} */
let tagList = null;

/**
 * version tags, newest first: names only, the notes load per release. empty when github can't be reached
 *
 * @return {Promise<string[]>}
 */
function versionTags(){
    tagList ??= fetch(`${REPO_API}/tags?per_page=100`)
        .then((res) => (res.ok ? res.json() : []))
        .then((/** @type {{name?: string}[]} */ data) => data
            .map((tag) => String(tag.name))
            .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
            .sort((x, y) => semverCompare(y, x)))
        .catch(() => {
            tagList = null;
            return [];
        });
    return tagList;
}

/** @type {Map<string, Promise<{body: string, date: string}|null>>} */
const notesCache = new Map();

/**
 * @param {string} tag
 * @return {Promise<{body: string, date: string}|null>} empty body: no published release (a draft keeps its tag). null: github can't be reached
 */
function releaseNotes(tag){
    let notes = notesCache.get(tag);
    if (!notes){
        notes = fetch(`${REPO_API}/releases/tags/${encodeURIComponent(tag)}`)
            .then((res) => (res.ok || res.status === 404 ? res.json() : null))
            .then((data) => (data ? { body: String(data.body ?? ""), date: String(data.published_at ?? "").slice(0, 10) } : null))
            .catch(() => {
                notesCache.delete(tag);
                return null;
            });
        notesCache.set(tag, notes);
    }
    return notes;
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

        const element = (/** @type {string} */ id) => shadow.getElementById(id);
        const logoImage = /** @type {HTMLImageElement|null} */ (element("changelogLogo"));
        if (logoImage) logoImage.src = logo.default;
        const content = element("changelogContent");
        if (content) content.textContent = "Loading release notes...";
        const versionLabel = element("changelogVersion");
        if (versionLabel) versionLabel.textContent = version;

        const controller = new AbortController();
        const close = () => {
            controller.abort();
            overlay.remove();
        };
        for (const id of ["changelogClose", "changelogDone"]){
            const button = element(id);
            if (button) button.onclick = close;
        }
        overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) close();
        });

        /** @type {string[]} newest first, the opened version is in it even without a tag (dev build) */
        let tags = [version];
        let shown = 0;
        let renders = 0;

        const updateNav = () => {
            const position = element("changelogPosition");
            if (position) position.textContent = `${tags.length - shown} / ${tags.length}`;
            element("changelogOlder")?.classList.toggle("changelogDisabled", shown === tags.length - 1);
            element("changelogNewer")?.classList.toggle("changelogDisabled", shown === 0);
            const nav = element("changelogNav");
            if (nav) nav.style.display = tags.length > 1 ? "" : "none";
        };

        const show = async(/** @type {number} */ index) => {
            shown = Math.min(Math.max(index, 0), tags.length - 1);
            const tag = tags[shown];
            const render = ++renders;
            const releaseUrl = `https://github.com/NullDev/Kute/releases/tag/${tag}`;
            if (versionLabel) versionLabel.textContent = tag;
            const github = element("changelogGithub");
            if (github) github.onclick = () => window.chrome.webview.postMessage(`open-url, ${releaseUrl}`);
            updateNav();

            const notes = await releaseNotes(tag);
            // a quicker click already moved on
            if (render !== renders || !content) return;
            const eyebrow = element("changelogEyebrow");
            let label = notes?.date ? `[ RELEASED ${notes.date} ]` : "[ RELEASE NOTES ]";
            if (tag === version) label = "[ WHAT'S NEW ]";
            if (eyebrow) eyebrow.textContent = label;
            if (!notes){
                content.innerHTML = "<span id='changelogError'>Could not load these release notes. View them on GitHub instead.</span>";
                return;
            }
            const htmlContent = await marked.parse(notes.body || "No release notes found.", { breaks: true, async: true });
            if (render !== renders) return;
            content.innerHTML = htmlContent;
            element("changelogContentWrapper")?.scrollTo(0, 0);

            // anchors can't scroll in here, point them at the release page
            for (const a of content.querySelectorAll("a")){
                if (a.getAttribute("href")?.startsWith("#")) a.setAttribute("href", releaseUrl + a.getAttribute("href"));
                a.setAttribute("target", "_blank");
                a.setAttribute("rel", "noopener");
            }
        };

        const older = element("changelogOlder");
        if (older) older.onclick = () => show(shown + 1);
        const newer = element("changelogNewer");
        if (newer) newer.onclick = () => show(shown - 1);
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key === "Escape") close();
                else if (event.key === "ArrowLeft") show(shown + 1);
                else if (event.key === "ArrowRight") show(shown - 1);
                else return;
                event.stopPropagation();
            },
            { signal: controller.signal, capture: true },
        );

        // the arrows come with the tag names, the opened notes don't wait for them
        versionTags().then((names) => {
            if (names.length === 0 || controller.signal.aborted) return;
            const current = tags[shown];
            tags = names.includes(version) ? names : [version, ...names].sort((x, y) => semverCompare(y, x));
            shown = Math.max(0, tags.indexOf(current));
            updateNav();
        });
        await show(0);
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
