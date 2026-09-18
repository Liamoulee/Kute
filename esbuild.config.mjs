import { readFile } from "node:fs/promises";
import { build, transform } from "esbuild";

/**
 * Esbuild plugin that minifies imported .css files and exposes them as text.
 *
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
 * Esbuild plugin that collapses whitespace in imported .html files and minifies their inline scripts.
 *
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

            // replace all script tags with placeholders cause they get owned by my whitespace remover 3000
            contents = contents.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, (_, scriptContent) => {
                scripts.push(scriptContent);
                return `___SCRIPT_${index++}___`;
            });

            for (let i = 0; i < scripts.length; i++){
                const transformed = await transform(scripts[i], { loader: "js", minify: true });
                scripts[i] = transformed.code;
            }

            // holy minifier
            contents = contents.replace(/\s+/g, " ").trim();

            // reinstert script tags
            for (let i = 0; i < scripts.length; i++){
                const minifiedCode = scripts[i];
                contents = contents.replace(`___SCRIPT_${i}___`, `<script>${minifiedCode}</script>`);
            }

            return { loader: "text", contents };
        });
    },
};

// the bundle reports its own version with an error (it is hot updated, so the client version says nothing about it)
const cargoToml = await readFile("./Cargo.toml", "utf8");
const bundleVersion = /js_bundle_version\s*=\s*"([^"]+)"/.exec(cargoToml)?.[1] ?? "0.0.0";

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
    define: {
        KUTE_BUNDLE_VERSION: JSON.stringify(bundleVersion),
    },
    loader: {
        ".html": "text",
        ".webp": "dataurl",
    },
    outfile: "./target/bundle.js",
    plugins: [textMinifyPlugin, minifyCSS],
})
    .then(() => {
        console.log("Build completed successfully!");
    })
    .catch((error) => {
        console.error("Build failed:", error);
        process.exit(1);
    });
