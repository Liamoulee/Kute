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

/**
 * @param {string} source
 * @return {string} HTML with one span per token worth coloring
 */
export function highlight(source){
    let html = "";
    let last = 0;
    for (const match of source.matchAll(TOKENS)){
        const index = match.index ?? 0;
        const [text, comment, string, number, word] = match;
        let kind = "";
        if (comment) kind = "c";
        else if (string) kind = "s";
        else if (number) kind = "n";
        else if (word){
            if (KEYWORDS.has(word)) kind = "k";
            else if (LITERALS.has(word)) kind = "l";
            else if (/^\s*\(/.test(source.slice(index + word.length, index + word.length + 40))) kind = "f";
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
 * @return {CodeEditor}
 */
export function createCodeEditor(container, content, { onSave, onDirtyChange }){
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
        code.innerHTML = `${highlight(value)}\n `;
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

    textarea.addEventListener("input", () => {
        if (textarea.value.length < 150_000) render();
        else if (!pending) pending = setTimeout(render, 150);
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
            const extra = /[{[(]\s*$/.test(line) ? "    " : "";
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
