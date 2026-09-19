import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const buildType = args[0];

// cef-dll-sys copies the CEF runtime (libcef.dll, *.pak, locales/, ...) next to the exe when its build script runs,
// this fills in what a skipped build script left out and stages what cargo does not: the VC runtime, the js bundle
// and the OBS plugin. dist/ collects the shippable subset of the target dir for the installer
const targetDir = path.join(process.cwd(), "target", buildType);
const targetResourcesDir = path.join(targetDir, "resources");
const distDir = path.join(targetDir, "dist");

const cefRuntimeFiles = [
    "libcef.dll",
    "chrome_elf.dll",
    "d3dcompiler_47.dll",
    "dxcompiler.dll",
    "dxil.dll",
    "libEGL.dll",
    "libGLESv2.dll",
    "vk_swiftshader.dll",
    "vk_swiftshader_icd.json",
    "vulkan-1.dll",
    "icudtl.dat",
    "resources.pak",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "v8_context_snapshot.bin",
];

const vcRuntimeFiles = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

/**
 * Copies a file when it exists, returns whether it did.
 *
 * @param {string} source
 * @param {string} destination
 * @return {boolean}
 */
function copyIfExists(source, destination){
    if (!fs.existsSync(source)) return false;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return true;
}

/**
 * Copies all files and directories from the source to the destination recursively.
 *
 * @param {string} source
 * @param {string} destination
 */
function copyDirAll(source, destination){
    fs.mkdirSync(destination, { recursive: true });

    for (const entry of fs.readdirSync(source, { withFileTypes: true })){
        const sourcePath = path.join(source, entry.name);
        const destPath = path.join(destination, entry.name);

        if (entry.isDirectory()) copyDirAll(sourcePath, destPath);
        else fs.copyFileSync(sourcePath, destPath);
    }
}

/**
 * The CEF distribution cef-dll-sys downloaded for the version in Cargo.lock. Its build script copies the runtime next
 * to the exe only when it runs, and a restored CI cache (rust-cache prunes loose files in the target dir) skips it,
 * so the runtime gets taken from here. Old distributions of an earlier cef bump may still be around, hence the check.
 *
 * @return {string|null}
 */
function findCefDistribution(){
    const lock = fs.readFileSync(path.join(process.cwd(), "Cargo.lock"), "utf8");
    const cefVersion = /name = "cef-dll-sys"\r?\nversion = "[^"+]+\+([^"]+)"/.exec(lock)?.[1];
    const buildDir = path.join(targetDir, "build");
    if (!cefVersion || !fs.existsSync(buildDir)) return null;

    const matches = [];
    for (const entry of fs.readdirSync(buildDir)){
        if (!entry.startsWith("cef-dll-sys-")) continue;
        const dir = path.join(buildDir, entry, "out", "cef_windows_x86_64");
        const archive = path.join(dir, "archive.json");
        if (!fs.existsSync(archive)) continue;
        if (!String(JSON.parse(fs.readFileSync(archive, "utf8")).name).startsWith(`cef_binary_${cefVersion}+`)) continue;
        matches.push({ dir, time: fs.statSync(archive).mtimeMs });
    }
    return matches.sort((a, b) => b.time - a.time)[0]?.dir ?? null;
}

try {
    fs.mkdirSync(targetResourcesDir, { recursive: true });

    const cefDistribution = findCefDistribution();
    if (cefDistribution){
        for (const file of cefRuntimeFiles){
            const destination = path.join(targetDir, file);
            if (!fs.existsSync(destination)) copyIfExists(path.join(cefDistribution, file), destination);
        }
        const locales = path.join(targetDir, "locales");
        if (!fs.existsSync(locales)) copyDirAll(path.join(cefDistribution, "locales"), locales);
    }
    else console.warn("No CEF distribution for the cef-dll-sys version in Cargo.lock found in the build dir.");

    for (const file of vcRuntimeFiles){
        const destination = path.join(targetDir, file);
        if (!fs.existsSync(destination)) copyIfExists(path.join(process.cwd(), "resources", "vcredist", file), destination);
    }

    copyIfExists(path.join(process.cwd(), "target", "bundle_version"), path.join(targetResourcesDir, "bundle_version"));
    copyIfExists(path.join(process.cwd(), "target", "bundle.js"), path.join(targetResourcesDir, "bundle.js"));

    if (!copyIfExists(path.join(targetDir, "obs_kute_capture.dll"), path.join(targetResourcesDir, "obs-kute-capture.dll"))){
        console.warn("OBS plugin was not built; skipping bundled plugin copy.");
    }

    // our own CEF build (aim freeze patches, see CLAUDE.md) replaces the stock files cef-dll-sys copied.
    // same CEF version, so the downloaded headers, wrapper and resources still match
    const patchedCefDir = path.join(process.cwd(), "resources", "cef");
    if (fs.existsSync(patchedCefDir)){
        for (const file of fs.readdirSync(patchedCefDir)){
            const source = path.join(patchedCefDir, file);
            // a checkout without git lfs leaves a small pointer file behind, never ship that
            if (fs.statSync(source).size < 1024){
                console.warn(`${file} in resources/cef is a git lfs pointer, run "git lfs pull". Keeping the stock file.`);
                continue;
            }
            fs.copyFileSync(source, path.join(targetDir, file));
        }
    }

    // installer payload, everything except the exe itself (which the wxs references directly)
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });
    // a missing file here is an installer that cannot start, so it fails the build instead of warning
    const missing = [...cefRuntimeFiles, ...vcRuntimeFiles, "render.dll"].filter(
        (file) => !copyIfExists(path.join(targetDir, file), path.join(distDir, file)),
    );
    if (fs.existsSync(path.join(targetDir, "locales"))) copyDirAll(path.join(targetDir, "locales"), path.join(distDir, "locales"));
    else missing.push("locales/");
    copyDirAll(targetResourcesDir, path.join(distDir, "resources"));

    if (missing.length > 0){
        console.error(`Missing from ${targetDir}: ${missing.join(", ")}`);
        process.exitCode = 1;
    }
}
catch (error){
    console.error("cannot copy", error);
    process.exitCode = 1;
}
