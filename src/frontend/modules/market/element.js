import { esc } from "./presentation.js";

/** @typedef {{html:string}} Markup */

/** @param {string} html @return {Markup} */
export const markup = (html) => ({ html });

/** @param {string} tag @param {Record<string,string|number|boolean|null>} attributes @param {...(string|number|Markup)} children */
export function element(tag, attributes, ...children){
    const attrs = Object.entries(attributes).filter(([, value]) => value !== false && value !== null)
        .map(([name, value]) => value === true ? ` ${name}` : ` ${name}="${esc(String(value))}"`).join("");
    const body = children.map((child) => typeof child === "object" ? child.html : esc(String(child))).join("");
    return `<${tag}${attrs}>${body}</${tag}>`;
}

/** @param {TemplateStringsArray} strings @param {...unknown} values */
export const html = (strings, ...values) => strings.reduce((result, part, i) => result + String(values[i - 1]) + part);
