import { kute } from "../client.js";

// windows[22] is the player list, its ping icons become numbers
class ShowPing {
    constructor(){
        /** @type {() => string} */
        this.originalGenList = window.windows[22].genList;
        this.template = document.createElement("template");

        kute.settings.toggleShowPing = (enabled) => this.toggle(enabled);

        this.toggle(true);
    }

    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        const showPing = this;
        // krunker's genList reads the search box text from its window (this.playerSearch), so that stays its this
        if (enabled){
            window.windows[22].genList = /** @this {object} */ function(){
                return showPing.modifiedGenList(this);
            };
        }
        else window.windows[22].genList = this.originalGenList;
    }

    /**
     * @param {object} listWindow
     * @return {string}
     */
    modifiedGenList(listWindow){
        const htmlString = this.originalGenList.call(listWindow);

        // template instead of DOMParser, that built a whole document per refresh
        this.template.innerHTML = htmlString;
        const pingIcons = this.template.content.querySelectorAll(".pListPing.material-icons");

        for (const icon of pingIcons){
            const pingValue = icon.getAttribute("title");

            icon.classList.remove("pListPing", "material-icons");
            icon.removeAttribute("title");

            icon.textContent = `${pingValue ? pingValue : "N/A"} `;
        }
        return this.template.innerHTML;
    }
}

export default new ShowPing();
