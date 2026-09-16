/**
 * Replaces the ping icons in the player list with the numeric ping.
 */
class ShowPing {
    constructor(){
        /** @type {() => string} */
        this.originalGenList = window.windows[22].genList;

        window.kute.settings.toggleShowPing = (enabled) => this.toggle(enabled);

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

        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, "text/html");
        const pingIcons = doc.querySelectorAll(".pListPing.material-icons");

        for (const icon of pingIcons){
            const pingValue = icon.getAttribute("title");

            icon.classList.remove("pListPing", "material-icons");
            icon.removeAttribute("title");

            icon.textContent = `${pingValue ? pingValue : "N/A"} `;
        }
        return doc.body.innerHTML;
    }
}

export default new ShowPing();
