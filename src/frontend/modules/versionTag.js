import { kute } from "../client.js";

/**
 * Writes the client version into the match info under the timer, between the mode and the map line
 * ("Free For All" / "Kute v0.1.7" / "on Burg").
 *
 * Pure CSS on purpose: #matchInfo is a text node for the mode plus a div for the map line, and the game rewrites
 * both on every match. A pseudo element on that div survives all of it and touches nothing of Krunker's.
 */
class VersionTag {
    constructor(){
        if (!kute.version) return;

        const style = document.createElement("style");
        style.id = "kute_versionTagCSS";
        style.textContent = `
            #matchInfo > div::before {
                content: ${JSON.stringify(`Kute v${kute.version}`)};
                display: block;
                color: #35e0e8;
            }`;
        document.head.append(style);
    }
}

export default new VersionTag();
