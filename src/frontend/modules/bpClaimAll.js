const button = document.createElement("div");
button.className = "bpBtn skip";
button.id = "claimAllBtn";
button.textContent = "Claim All";

/**
 * Returns the visible battle pass reward buttons that can still be claimed.
 *
 * @return {HTMLElement[]}
 */
function findClaimables(){
    return Array.from(/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".bpClaimB"))).filter(
        (btn) => btn.offsetParent !== null && btn.textContent.trim() === "Claim",
    );
}

/**
 * Enables or disables the claim-all button depending on whether anything is claimable.
 */
function updateButtonState(){
    const hasClaimable = findClaimables().length > 0;
    hasClaimable ? button.classList.remove("disabled") : button.classList.add("disabled");
    button.textContent = hasClaimable ? "Claim All" : "Nothing to Claim";
}

/**
 * Clicks every claimable reward with a short delay in between.
 *
 * @return {Promise<void>}
 */
async function claimEverything(){
    const items = findClaimables();
    if (items.length === 0) return;

    for (const btn of items){
        const code = btn.getAttribute("onclick");
        if (code?.includes("windows[5].claimItem(")) btn.click();

        await new Promise((r) => setTimeout(r, 200));
    }

    updateButtonState();
}

button.onclick = () => {
    window.playSelect?.(0.1);
    claimEverything();
};

/**
 * Appends the claim-all button to the battle pass window.
 */
function addClaimAllButton(){
    const bar = document.querySelector(".bpBotH");
    if (!bar) return;

    bar.append(button);
    updateButtonState();
}

const originalshowWindow = window.showWindow;
/**
 * Wraps Krunker's showWindow to inject the button when the battle pass window (6) opens.
 *
 * @param {...any} args
 * @return {any}
 */
window.showWindow = (...args) => {
    const number = args[0];
    if (number === 6) queueMicrotask(() => addClaimAllButton());
    return originalshowWindow.apply(this, args);
};

export {};
