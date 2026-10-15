import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// builds target/kute-x86_64.AppImage from target/release/dist plus the binary, run on linux after the release build and postbuild
// KUTE_BUILD=debug packages a dev build, the only kind that reads KUTE_UPDATE_URL
const releaseDir = path.join(process.cwd(), "target", process.env.KUTE_BUILD ?? "release");
const appDir = path.join(process.cwd(), "target", "appimage", "Kute.AppDir");
const outPath = path.join(process.cwd(), "target", "kute-x86_64.AppImage");
// pinned, "continuous" moves under a release build. APPIMAGETOOL points at a local copy instead
const toolUrl = "https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage";
const toolPath = process.env.APPIMAGETOOL ?? path.join(process.cwd(), "target", "tools", "appimagetool-1.9.1-x86_64.AppImage");
// appimagehub wants the desktop file and the metainfo named after this
const appId = "lol.kute.Kute";
const version = /^version = "([^"]+)"/m.exec(fs.readFileSync(path.join(process.cwd(), "Cargo.toml"), "utf8"))?.[1];
const screenshotBase = "https://raw.githubusercontent.com/NullDev/Kute/master/resources/screenshots";

// the binary is called kute, everything cef needs sits next to it (rpath $ORIGIN)
const appRun = `#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/kute" "$@"
`;

// StartupWMClass matches the window class window.rs sets
const desktopEntry = `[Desktop Entry]
Type=Application
Name=Kute
Comment=Krunker client
Exec=kute
Icon=kute
Categories=Game;
StartupWMClass=kute
Terminal=false
`;

// screenshots are urls, they only resolve once resources/screenshots is on master
const metainfo = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>
  <name>Kute</name>
  <summary>High-performance Krunker client</summary>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>GPL-3.0-only</project_license>
  <developer id="lol.kute">
    <name>NullDev</name>
  </developer>
  <description>
    <p>Kute is a Krunker.io client running on its own patched Chromium (CEF). It brings uncapped FPS with an exact frame limiter, native raw mouse input and the aim freeze fix of uncapped clients.</p>
    <p>It also comes with a resource swapper, userscripts, a HUD editor, a matchmaker, an account manager and Auto-Detect Best Settings, which benchmarks your PC and keeps only what measurably runs better.</p>
  </description>
  <launchable type="desktop-id">${appId}.desktop</launchable>
  <url type="homepage">https://kute.lol</url>
  <url type="bugtracker">https://github.com/NullDev/Kute/issues</url>
  <url type="vcs-browser">https://github.com/NullDev/Kute</url>
  <categories>
    <category>Game</category>
  </categories>
  <content_rating type="oars-1.1">
    <content_attribute id="violence-cartoon">intense</content_attribute>
    <content_attribute id="social-chat">intense</content_attribute>
  </content_rating>
  <screenshots>
    <screenshot type="default">
      <caption>Client settings inside Krunker</caption>
      <image>${screenshotBase}/settings.png</image>
    </screenshot>
    <screenshot>
      <caption>HUD editor</caption>
      <image>${screenshotBase}/hud-editor.png</image>
    </screenshot>
    <screenshot>
      <caption>Resource swapper and userscripts</caption>
      <image>${screenshotBase}/swapper.png</image>
    </screenshot>
  </screenshots>
  <releases>
    <release version="${version}" date="${new Date().toISOString().slice(0, 10)}"/>
  </releases>
</component>
`;

/**
 * @return {Promise<string>}
 */
async function appimagetool(){
    if (fs.existsSync(toolPath)) return toolPath;
    console.log(`Downloading ${toolUrl}`);
    const response = await fetch(toolUrl);
    if (!response.ok) throw new Error(`appimagetool download failed with ${response.status}`);
    fs.mkdirSync(path.dirname(toolPath), { recursive: true });
    fs.writeFileSync(toolPath, Buffer.from(await response.arrayBuffer()));
    fs.chmodSync(toolPath, 0o755);
    return toolPath;
}

try {
    if (process.platform !== "linux") throw new Error("AppImages are built on linux");
    if (!version) throw new Error("no version in Cargo.toml");

    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(outPath, { force: true });

    fs.cpSync(path.join(releaseDir, "dist"), appDir, { recursive: true });
    fs.copyFileSync(path.join(releaseDir, "kute"), path.join(appDir, "kute"));
    fs.chmodSync(path.join(appDir, "kute"), 0o755);
    fs.writeFileSync(path.join(appDir, "AppRun"), appRun, { mode: 0o755 });
    fs.writeFileSync(path.join(appDir, `${appId}.desktop`), desktopEntry);
    fs.mkdirSync(path.join(appDir, "usr", "share", "metainfo"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "usr", "share", "metainfo", `${appId}.metainfo.xml`), metainfo);
    fs.copyFileSync(path.join(process.cwd(), "resources", "kute-256.png"), path.join(appDir, "kute.png"));
    fs.copyFileSync(path.join(process.cwd(), "resources", "kute-256.png"), path.join(appDir, ".DirIcon"));

    // no fuse needed, ci runners and containers have none
    const result = spawnSync(await appimagetool(), [appDir, outPath], {
        stdio: "inherit",
        env: { ...process.env, ARCH: "x86_64", APPIMAGE_EXTRACT_AND_RUN: "1" },
    });
    if (result.status !== 0) throw new Error(`appimagetool exited with ${result.status ?? result.error}`);

    console.log(`Wrote ${outPath} (${Math.round(fs.statSync(outPath).size / 1048576)} MB)`);
}
catch (error){
    console.error("cannot build the AppImage", error);
    process.exitCode = 1;
}
