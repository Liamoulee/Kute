// tiny code editor: transparent textarea over a highlighted pre, so undo/paste/selection stay native

const KEYWORDS = new Set(("async await break case catch class const continue debugger default delete do else export extends " +
    "finally for function if import in instanceof let new of return static super switch throw try typeof var void " +
    "while with yield get set").split(" "));
const LITERALS = new Set(["true", "false", "null", "undefined", "this", "NaN", "Infinity"]);

// comments, strings (unfinished ones run to end of line, templates to end of text), numbers, words
const TOKENS = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?)|(\b\d[\d_]*(?:\.[\d_]+)?(?:e[+-]?\d+)?n?\b|\b0x[\da-fA-F_]+n?\b)|([A-Za-z_$][\w$]*)/g;

/**
 * @param {string} text
 * @return {string}
 */
const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// comments, strings, at-rules and !important, hex colors, numbers with units, words
const CSS_TOKENS = /(\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)|(@[\w-]+|!\s*important\b)|(#[\da-fA-F]{3,8}\b|-?(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:%|[a-zA-Z]+)?)|(-?-?[a-zA-Z_][\w-]*)/g;

/** @typedef {"js"|"css"|"text"} Language */

/**
 * @param {string} path
 * @return {Language}
 */
export const languageFor = (path) => {
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (extension === "css") return "css";
    if (["js", "mjs", "json"].includes(extension)) return "js";
    return "text";
};

/**
 * @param {string} source
 * @param {number} end Where the word ends
 * @return {boolean} The word is followed by a colon that ends in a declaration, not a selector like a:hover {
 */
const isProperty = (source, end) => /^\s*:[^{};]*(?:[;}]|$)/.test(source.slice(end, end + 400));

/**
 * @param {string} source
 * @param {Language} [language]
 * @return {string} HTML with one span per token worth coloring
 */
export function highlight(source, language = "js"){
    if (language === "text") return escapeHtml(source);
    const css = language === "css";
    let html = "";
    let last = 0;
    for (const match of source.matchAll(css ? CSS_TOKENS : TOKENS)){
        const index = match.index ?? 0;
        const [text] = match;
        let kind = "";
        if (css){
            const [, comment, string, keyword, number, word] = match;
            if (comment) kind = "c";
            else if (string) kind = "s";
            else if (keyword) kind = "k";
            else if (number) kind = "n";
            else if (word){
                const end = index + word.length;
                if (source[end] === "(") kind = "f";
                else if (word.startsWith("--") || isProperty(source, end)) kind = "l";
            }
        }
        else {
            const [, comment, string, number, word] = match;
            if (comment) kind = "c";
            else if (string) kind = "s";
            else if (number) kind = "n";
            else if (word){
                if (KEYWORDS.has(word)) kind = "k";
                else if (LITERALS.has(word)) kind = "l";
                else if (/^\s*\(/.test(source.slice(index + word.length, index + word.length + 40))) kind = "f";
            }
        }
        if (!kind) continue;
        html += escapeHtml(source.slice(last, index)) + `<span class="tk-${kind}">${escapeHtml(text)}</span>`;
        last = index + text.length;
    }
    return html + escapeHtml(source.slice(last));
}

/**
 * @typedef {object} CodeEditor
 * @property {() => string} getValue
 * @property {() => boolean} isDirty
 * @property {() => void} markSaved
 * @property {() => void} focus
 */

/**
 * @param {HTMLElement} container Gets the editor as its only child
 * @param {string} content
 * @param {object} options
 * @param {() => void} options.onSave Ctrl+S
 * @param {(dirty: boolean) => void} options.onDirtyChange
 * @param {(value: string) => void} [options.onChange] After every edit, debounced on big files
 * @param {Language} [options.language]
 * @return {CodeEditor}
 */
export function createCodeEditor(container, content, { onSave, onDirtyChange, onChange, language = "js" }){
    container.innerHTML = `<div class="editor"><div class="editorGutter"></div><div class="editorCode"><pre><code></code></pre>
        <textarea spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"></textarea></div></div>`;
    const gutter = /** @type {HTMLElement} */ (container.querySelector(".editorGutter"));
    const pre = /** @type {HTMLElement} */ (container.querySelector("pre"));
    const code = /** @type {HTMLElement} */ (container.querySelector("code"));
    const textarea = /** @type {HTMLTextAreaElement} */ (container.querySelector("textarea"));
    textarea.value = content;

    let saved = content;
    let dirty = false;
    let lineCount = 0;
    /** @type {number} */
    let pending = 0;

    const syncScroll = () => {
        pre.scrollTop = textarea.scrollTop;
        pre.scrollLeft = textarea.scrollLeft;
        gutter.scrollTop = textarea.scrollTop;
    };

    const render = () => {
        pending = 0;
        const { value } = textarea;
        // extra line so a trailing newline matches the textarea height
        code.innerHTML = `${highlight(value, language)}\n `;
        const lines = value.split("\n").length;
        if (lines !== lineCount){
            lineCount = lines;
            gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
        }
        syncScroll();
        const nowDirty = value !== saved;
        if (nowDirty !== dirty){
            dirty = nowDirty;
            onDirtyChange(dirty);
        }
    };

    /**
     * @param {string} text
     */
    const insert = (text) => {
        // deprecated, but the only insert that ctrl+z can undo
        document.execCommand("insertText", false, text);
    };

    const changed = () => {
        render();
        onChange?.(textarea.value);
    };
    textarea.addEventListener("input", () => {
        if (textarea.value.length < 150_000) changed();
        else if (!pending) pending = setTimeout(changed, 150);
    });
    textarea.addEventListener("scroll", syncScroll);
    textarea.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s"){
            event.preventDefault();
            onSave();
            return;
        }
        if (event.key === "Tab" && !event.ctrlKey && !event.altKey){
            event.preventDefault();
            const { selectionStart, selectionEnd, value } = textarea;
            const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
            if (event.shiftKey){
                const spaces = /^ {1,4}/.exec(value.slice(lineStart))?.[0].length ?? 0;
                if (!spaces) return;
                textarea.setSelectionRange(lineStart, lineStart + spaces);
                document.execCommand("delete");
                textarea.setSelectionRange(Math.max(lineStart, selectionStart - spaces), Math.max(lineStart, selectionEnd - spaces));
                return;
            }
            insert("    ");
            return;
        }
        if (event.key === "Enter" && !event.ctrlKey && !event.altKey && !event.shiftKey){
            // keep indent, one more after an opening bracket
            event.preventDefault();
            const { selectionStart, value } = textarea;
            const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
            const line = value.slice(lineStart, selectionStart);
            const indent = /^\s*/.exec(line)?.[0] ?? "";
            const extra = language !== "text" && /[{[(]\s*$/.test(line) ? "    " : "";
            insert(`\n${indent}${extra}`);
        }
    });

    render();

    return {
        getValue: () => textarea.value,
        isDirty: () => dirty,
        markSaved(){
            saved = textarea.value;
            render();
        },
        focus(){
            textarea.focus();
            textarea.setSelectionRange(0, 0);
        },
    };
}

/**
 * @typedef {object} EditorView
 * @property {CodeEditor} editor
 * @property {HTMLElement} bar Title and buttons, callers can add their own in front of Save
 * @property {HTMLElement} saveButton
 */

/**
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @return {HTMLElement}
 */
const element = (tag, className, text = "") => {
    const created = document.createElement(tag);
    created.className = className;
    created.textContent = text;
    return created;
};

/**
 * Title bar with Save, Save & close and Close above the editor.
 *
 * @param {HTMLElement} parent Gets the view as its only child
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.content
 * @param {Language} options.language
 * @param {boolean} [options.isNew]
 * @param {(closeAfter: boolean) => void} options.onSave
 * @param {() => void} options.onClose
 * @param {(value: string) => void} [options.onChange]
 * @return {EditorView}
 */
export function createEditorView(parent, { title, content, language, isNew = false, onSave, onClose, onChange }){
    parent.textContent = "";
    const view = element("div", "editorView");
    const bar = element("div", "editorBar");
    const titleElement = element("div", "editorFile", title);
    const dirtyMark = element("span", "dirty", isNew ? " (new, not saved yet)" : "");
    titleElement.append(dirtyMark);
    const saveButton = element("div", "btn primary", "Save");
    const saveCloseButton = element("div", "btn", "Save & close");
    const closeButton = element("div", "btn", "Close");
    saveButton.onclick = () => onSave(false);
    saveCloseButton.onclick = () => onSave(true);
    closeButton.onclick = onClose;
    bar.append(titleElement, saveButton, saveCloseButton, closeButton);
    const container = element("div", "");
    container.style.cssText = "display:flex;flex:1 1 auto;min-height:0";
    view.append(bar, container, element("div", "editorKeys", "Ctrl+S save  ·  Ctrl+Z / Ctrl+Y undo, redo  ·  Tab / Shift+Tab indent  ·  Esc close"));
    parent.append(view);

    const editor = createCodeEditor(container, content, {
        language,
        onChange,
        onSave: () => onSave(false),
        onDirtyChange: (dirty) => {
            dirtyMark.textContent = dirty ? "  ● unsaved" : "";
        },
    });
    editor.focus();
    return { editor, bar, saveButton };
}
