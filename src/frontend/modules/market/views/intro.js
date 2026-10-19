import { element, markup } from "../element.js";

/** @param {import("../terminal.js").Terminal} _desk @param {string} title @param {string} subtitle @param {string} [actions] */
export function introView(_desk, title, subtitle, actions = ""){
    const heading = element("h1", {}, title);
    const description = element("p", { "class": "sub" }, subtitle);
    return element("div", { "class": "pageIntro" }, markup(element("div", {}, markup(heading + description))), markup(actions));
}
