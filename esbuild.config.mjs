import path from "node:path";
import { readFile } from "node:fs/promises";
import { build, transform } from "esbuild";

/**
 * @type {import("esbuild").Plugin}
 */
export const minifyCSS = {
    name: "minifyCSS",
    setup(pluginBuild){
        pluginBuild.onLoad({ filter: /\.css$/ }, async(args) => {
            const file = await readFile(args.path, "utf8");
            const css = await transform(file, { loader: "css", minify: true });
            return { loader: "text", contents: css.code };
        });
    },
};

/**
 * @type {import("esbuild").Plugin}
 */
export const textMinifyPlugin = {
    name: "textMinifyPlugin",
    setup(pluginBuild){
        pluginBuild.onLoad({ filter: /\.html$/ }, async(args) => {
            let contents = await readFile(args.path, "utf8");

            /** @type {string[]} */
            const scripts = [];
            let index = 0;

            // park scripts in placeholders so the whitespace collapse doesn't wreck them
            contents = contents.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, (_, scriptContent) => {
                scripts.push(scriptContent);
                return `___SCRIPT_${index++}___`;
            });

            for (let i = 0; i < scripts.length; i++){
                const transformed = await transform(scripts[i], { loader: "js", minify: true });
                scripts[i] = transformed.code;
            }

            contents = contents.replace(/\s+/g, " ").trim();

            for (let i = 0; i < scripts.length; i++){
                const minifiedCode = scripts[i];
                contents = contents.replace(`___SCRIPT_${i}___`, `<script>${minifiedCode}</script>`);
            }

            return { loader: "text", contents };
        });
    },
};

/**
 * `import code from "popup-script:./queue.js"` gives the minified source as a string, for code injected elsewhere.
 *
 * @type {import("esbuild").Plugin}
 */
export const popupScriptPlugin = {
    name: "popupScriptPlugin",
    setup(pluginBuild){
        pluginBuild.onResolve({ filter: /^popup-script:/ }, (args) => ({
            path: path.resolve(args.resolveDir, args.path.slice("popup-script:".length)),
            namespace: "popup-script",
        }));
        pluginBuild.onLoad({ filter: /.*/, namespace: "popup-script" }, async(args) => {
            const source = await readFile(args.path, "utf8");
            const result = await transform(source, { loader: "js", minify: true });
            return { loader: "text", contents: result.code, watchFiles: [args.path] };
        });
    },
};

console.log("Starting esbuild process...");
await build({
    entryPoints: ["./src/frontend/main.js"],
    bundle: true,
    minify: true,
    format: "iife",
    treeShaking: true,
    minifyWhitespace: true,
    minifySyntax: true,
    ignoreAnnotations: true,
    loader: {
        ".html": "text",
        ".webp": "dataurl",
        ".ogg": "base64",
    },
    outfile: "./target/bundle.js",
    plugins: [textMinifyPlugin, minifyCSS, popupScriptPlugin],
})
    .then(() => {
        console.log("Build completed successfully!");
    })
    .catch((error) => {
        console.error("Build failed:", error);
        process.exit(1);
    });
