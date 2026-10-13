import { kute } from "../client.js";
import remap from "../components/kuteThemeRemap.css";
import theme from "../components/kuteTheme.css";

// the hand written theme last, it wins ties against the generated remap
const css = remap + theme;

class KuteCss {
    constructor(){
        /** @type {CSSStyleSheet|null} */
        this.sheet = null;
        kute.settings.toggleKuteCss = (enabled) => this.toggle(enabled);
        this.toggle(true);
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        if (!enabled){
            this.sheet?.replaceSync("");
            return;
        }
        if (!this.sheet){
            this.sheet = new CSSStyleSheet();
            // first of the adopted sheets, so the player's custom css still wins
            document.adoptedStyleSheets = [this.sheet, ...document.adoptedStyleSheets];
        }
        this.sheet.replaceSync(css);
    }
}

export default new KuteCss();
