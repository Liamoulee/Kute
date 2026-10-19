import template from "../../../components/marketHelp.html";
import { introView } from "./intro.js";

/** @param {import("../terminal.js").Terminal} desk */
export function helpView(desk){
    return {
        html:
            introView(desk, "Understand the estimate.", "What the numbers mean, where they come from, and when to treat them cautiously.") +
            template,
    };
}
