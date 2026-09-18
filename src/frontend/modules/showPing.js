import { kute } from "../client.js";

/**
 * Replaces the ping icons in the player list with the numeric ping.
 */
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
     * Renders the player list through the original function and swaps ping icons for numbers.
     *
     * @return {string}
     */
    modifiedGenList(){
        const htmlString = this.originalGenList.call(this);

        // a template parses the markup into a fragment. DOMParser built a whole second document for every
        // refresh of the player list
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
