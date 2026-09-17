import logo from "../components/logo.webp";

/**
 * Pins the client icon to the bottom right corner of the Krunker logo in the menu.
 * Pure CSS on purpose: the menu is mounted (and re-rendered) by Svelte, a pseudo element survives that.
 * The badge is anchored to #mainLogo, so it follows the logo whatever size the game gives it.
 */
class LogoBadge {
    constructor(){
        // only the game page has the menu mount
        if (!document.querySelector("#mainMenuUIMount")) return;

        const style = document.createElement("style");
        style.id = "kute_logoBadgeCSS";
        style.textContent = `
            #mainLogo { anchor-name: --kute-main-logo; }
            #gameNameHolder::after {
                content: "";
                position: absolute;
                position-anchor: --kute-main-logo;
                width: calc(anchor-size(width) * 0.25);
                aspect-ratio: 1;
                left: calc((anchor(right) - anchor-size(width) * 0.22) - 15px);
                top: calc((anchor(bottom) - anchor-size(height) * 0.48) - 10px);
                transform: rotate(-25deg);
                background: url(${logo}) center / contain no-repeat;
                pointer-events: none;
            }`;
        document.head.append(style);
    }
}

export default new LogoBadge();
