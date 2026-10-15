const WITHDRAWN = [{ key: "scoreboardName.js", name: "Scoreboard Name", author: "Kute" }];
const DONE_KEY = "kute_withdrawn";
// an exe without the manager commands never answers
const REPLY_MS = 10000;

/** @typedef {import("./managers/userscripts.js").ListedScript} ListedScript */

const done = localStorage.getItem(DONE_KEY) ?? "";
const pending = WITHDRAWN.filter((script) => !done.split(",").includes(script.key));

if (pending.length > 0){
    let timeout = 0;
    /** @type {(event: { data: any }) => void} */
    const listener = (event) => {
        const groups = event.data?.userscripts?.groups;
        if (!Array.isArray(groups)) return;
        window.chrome.webview.removeEventListener("message", listener);
        clearTimeout(timeout);
        const listed = /** @type {ListedScript[]} */ (groups.flatMap((group) => group.scripts ?? []));
        for (const script of pending){
            const match = listed.find((entry) => entry.key === script.key && entry.meta?.name === script.name && entry.meta?.author === script.author);
            if (!match) continue;
            window.chrome.webview.postMessage(`scripts-toggle ${JSON.stringify({ key: script.key, enabled: false })}`);
            window.chrome.webview.postMessage(`scripts-delete ${JSON.stringify({ key: script.key })}`);
        }
        localStorage.setItem(DONE_KEY, [...done.split(",").filter(Boolean), ...pending.map((script) => script.key)].join(","));
    };
    timeout = setTimeout(() => window.chrome.webview.removeEventListener("message", listener), REPLY_MS);
    window.chrome.webview.addEventListener("message", listener);
    window.chrome.webview.postMessage("scripts-list {}");
}

export {};
