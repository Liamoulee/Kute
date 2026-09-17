/**
 * @typedef {object} ConfirmOptions
 * @property {string} title
 * @property {string[]} paragraphs Plain text, one paragraph each
 * @property {string} stay Label of the highlighted button (resolves false)
 * @property {string} leave Label of the other button (resolves true)
 */

/**
 * A modal question with two answers. Closing it any other way (Escape, a click next to it) counts as "stay".
 *
 * @param {ConfirmOptions} options
 * @return {Promise<boolean>} true when the player chose the "leave" button
 */
export async function confirmPopup(options){
    const html = await import("../components/confirm.html");

    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
    const host = document.createElement("div");
    overlay.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = html.default;

    /**
     * @param {string} id
     * @return {HTMLElement}
     */
    const element = (id) => /** @type {HTMLElement} */ (shadow.querySelector(`#${id}`));
    element("confirmTitle").textContent = options.title;
    for (const paragraph of options.paragraphs){
        const p = document.createElement("p");
        p.textContent = paragraph;
        element("confirmText").append(p);
    }
    element("confirmStay").textContent = options.stay;
    element("confirmLeave").textContent = options.leave;

    return new Promise((resolve) => {
        const controller = new AbortController();
        /**
         * @param {boolean} leave
         */
        const answer = (leave) => {
            controller.abort();
            overlay.remove();
            resolve(leave);
        };
        element("confirmStay").onclick = () => answer(false);
        element("confirmLeave").onclick = () => answer(true);
        overlay.addEventListener("mousedown", (event) => {
            if (event.target === overlay) answer(false);
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key === "Escape") answer(false);
            },
            { signal: controller.signal },
        );
        document.body.append(overlay);
    });
}
