import styles from "../components/menuTimer.css";
import { kute } from "../client.js";

const STYLE_ID = "kute_menuTimerCSS";

class MenuTimer {
    constructor(){
        kute.settings.toggleMenuTimer = (enabled) => this.toggle(enabled);
        this.toggle(kute.settings.data.menuTimer !== false);
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        const existing = document.getElementById(STYLE_ID);
        if (!enabled){
            existing?.remove();
            return;
        }
        if (existing) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = styles;
        document.head.append(style);
    }
}

export default new MenuTimer();
