import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// zips what the msi installs (target/release/dist plus the exe), run after the release build and postbuild
const releaseDir = path.join(process.cwd(), "target", "release");
const stageDir = path.join(process.cwd(), "target", "portable");
const appDir = path.join(stageDir, "kute");
const zipPath = path.join(process.cwd(), "target", "kute-x86_64-portable.zip");

try {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });

    fs.cpSync(path.join(releaseDir, "dist"), appDir, { recursive: true });
    for (const file of ["kute.exe", "kute.pdb"]) fs.copyFileSync(path.join(releaseDir, file), path.join(appDir, file));
    // must match constants::PORTABLE_MARKER, the exe then never downloads or runs the msi
    fs.writeFileSync(path.join(appDir, "portable.flag"), "");

    // windows' own bsdtar, git's gnu tar earlier in PATH can't write zip
    const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const result = spawnSync(tar, ["-a", "-c", "-f", zipPath, "-C", stageDir, "kute"], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`tar exited with ${result.status ?? result.error}`);

    console.log(`Wrote ${zipPath}`);
}
catch (error){
    console.error("cannot build the portable zip", error);
    process.exitCode = 1;
}
