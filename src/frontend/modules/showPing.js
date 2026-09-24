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
        if (enabled) window.windows[22].genList = this.modifiedGenList.bind(this);
        else window.windows[22].genList = this.originalGenList;
    }

    /**
     * @return {string}
     */
    modifiedGenList(){
        const htmlString = this.originalGenList.call(this);

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
