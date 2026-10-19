import template from "../../../components/marketHelp.html";
import { introView } from "./intro.js";

/** @param {import("../terminal.js").Terminal} desk */
export function helpView(desk){
    return {
        html:
            introView(desk, "How it works.", "What the numbers mean.") +
            template,
    };
}
