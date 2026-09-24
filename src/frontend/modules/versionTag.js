import { kute } from "../client.js";

// pure css, the game rewrites #matchInfo every match
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
