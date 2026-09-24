import logo from "../components/logo.webp";

/**
 * pure css so it survives svelte re-renders
 */
class LogoBadge {
    constructor(){
        // game page only
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
