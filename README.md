![GitHub Downloads](https://img.shields.io/github/downloads/NullDev/Kute/total?label=Downloads) [![License](https://img.shields.io/github/license/NullDev/Kute?label=License&logo=Creative%20Commons)](https://github.com/NullDev/Kute/blob/master/LICENSE) [![Latest Release](https://img.shields.io/github/v/release/NullDev/Kute?style=flat&label=Latest)](https://github.com/NullDev/Kute/releases/latest) [![release](https://github.com/NullDev/Kute/actions/workflows/release.yml/badge.svg)](https://github.com/NullDev/Kute/actions/workflows/release.yml) [![Server Deploy](https://github.com/NullDev/Kute/actions/workflows/deploy-server.yml/badge.svg)](https://github.com/NullDev/Kute/actions/workflows/deploy-server.yml)

<p align="center"><img height="250" width="auto" src="/resources/icon.png" /></p>
<p align="center"><b>A high-performance Krunker client with enhanced features - made by <code>[cute]</code></b><br><a href="https://kute.lol">https://kute.lol</a></p>
<hr>

## :arrow_down: Download

- [Latest Release](https://github.com/NullDev/Kute/releases/latest)
- [All Releases](https://github.com/NullDev/Kute/releases)

<hr>

## :sparkles: About

Kute is a high-performance Krunker client designed to enhance your gaming experience with features like uncapped FPS, optimized performance tweaks, custom scripts, and more. It runs on its own bundled Chromium (CEF) and provides a seamless, feature-rich environment for both casual and competitive players. Brought to you by <code>[cute]</code>, and the same guy who co-developed [idkr](https://github.com/idkr-client/idkr) and contributed to [glorp](https://github.com/slavcp/glorp).

## :star: Features

- [x] Runs on its own bundled Chromium (CEF), no browser or runtime install needed
  - [x] Patched CEF: fixes the aim freeze and the GPU bottleneck stutter of uncapped clients
- [x] Uncapped FPS with a DXGI present hook: waitable flip swapchain, frame pacing, present FPS counter and an exact FPS limiter that keeps the CPU idle
- [x] **Proper** Raw input
- [x] Increased performance tweaks (chromium & CEF flags, game settings, system optimizations)
- [x] Auto-Detect: measures your PC in a private test match (about a minute) and sets up the game and the client for it, with undo
- [x] Selectable graphics backend (ANGLE: D3D11, D3D11on12, OpenGL, Vulkan) and color profile
- [x] Optimized URL blocklist (only ~50 entries, fully customizable), custom Chromium flags
- [x] Resource swapper
- [x] All settings togglable
- [x] Battle pass claim-all
- [x] Custom script support
- [x] OBS capture plugin (shared texture game capture plus a dedicated audio window)
- [x] Encrypted Account Manager
- [x] Queue ranked without the game open
- [x] Better ranked with ELO system
- [x] Find out your real ping to the servers
- [x] Better chat
- [x] Hardpoint enemy counter
- [x] Rank progress
- [x] Clan colors
- [x] Kute badge
- [x] Discord Rich Presence
- [x] CPU throttler (a last resort, see below)
- [x] Lightweight autoupdater & changelogs
- [x] Basic shortcuts (F4/F6 new lobby, F5 reload, F11 fullscreen, F12 devtools)
- [ ] Skin Swapper (coming soon)
- [ ] BetterKDR™️ (coming soon)
- [ ] Bloomberg-style trading terminal & market analysis (coming soon)
- [x] and more...

<hr>

## :lock: Potential issues

- The stutter known from other uncapped clients (FPS counter high, screen choppy, worst when the GPU is the limit) is fixed by the patched CEF. <br>
  If you still see it: run Auto-Detect, open its Advanced view, copy the report and [open an issue](https://github.com/NullDev/Kute/issues/choose).
- CPU Throttling pauses the game in short bursts and causes lag spikes. Leave it at 1 unless Auto-Detect sets it.
- Auto-Detect needs a Krunker account, because it measures in a private match.

<hr>

## :wrench: Building

### What is in this repo

| Path | What it is |
|---|---|
| [`src/`](/src) | The client itself, `kute.exe`: a Rust Win32 host that creates the window, embeds CEF, injects the JS bundle and handles input, updates, Discord, the account store and the IPC with the page. The same exe is also every Chromium subprocess. |
| [`src/frontend/`](/src/frontend) | The JS bundle injected into krunker.io (esbuild, one file, `target/bundle.js`). Every client feature that lives in the page is a module in [`modules/`](/src/frontend/modules), the settings come from [`src/cSettings.json`](/src/cSettings.json). |
| [`crates/render-dll`](/crates/render-dll) | `render.dll`, loaded into Chromium's GPU process: the DXGI present hook (flip swapchain, FPS limiter, frame stats) and the producer side of the OBS capture. |
| [`crates/obs-kute-capture`](/crates/obs-kute-capture) | The OBS plugin that shows the game through a shared texture. |
| [`resources/`](/resources) | Installer script (WiX), VC runtime, and the patched CEF DLL in [`resources/cef/`](/resources/cef) (Git LFS). |
| [`patches/`](/patches) | The two Chromium patches the CEF DLL is built with. |
| [`server/`](/server) | The server behind `kute.lol`: clan colors, the Kute badge presence and the anonymous Auto-Detect reports. Bun, Fastify, TypeScript, SQLite. Its own project with its own `package.json`. The client builds and runs without it, and plays the same when it is down. |

### Client

- Prerequisites:
  - [Git LFS](https://git-lfs.com/) (`git lfs install` once, **before** cloning, for the patched CEF DLL)
  - [Rust & Cargo](https://rustup.rs/)
  - [Microsoft Visual C++](https://visualstudio.microsoft.com/downloads/)
  - [CMake](https://cmake.org/download/) and [Ninja](https://github.com/ninja-build/ninja/releases) (the CEF wrapper is built on the first build)
  - [Bun](https://bun.sh/)
  - [WiX 6 **(if packaging)**](https://github.com/wixtoolset/wix/releases)

1. `git clone https://github.com/NullDev/Kute.git`
2. `cd Kute`
3. `bun i`
4. `bun run dev` (debug build with logs, then starts the client)

The first build downloads the official CEF distribution (about 900 MB) and compiles its wrapper, so it takes a while. Later builds are incremental. Close the client before building, a running one locks `libcef.dll`.

| Command | Does |
|---|---|
| `bun run dev` | Bundle, debug build with verbose logs, run |
| `bun run build` | Release build in `target/release` |
| `bun run package` | Release build with the auto-updater plus the MSI (`target/kute-setup-x86_64.msi`) |
| `bun run esbuild` | Only the JS bundle |
| `bun run lint` / `bun run typecheck` | ESLint and `tsc` over the client JS **and** the server TS |

### Do I have to build CEF?

**No.** The build downloads the official CEF 151 runtime on its own, and the patched `libcef.dll` comes out of Git LFS and is copied over the stock one by `postbuild.js`. Nothing to compile, nothing to configure.

- Cloned without Git LFS? The build notices the placeholder file, warns, and keeps the stock DLL. The client works, it just lacks the two fixes (aim freeze, GPU bottleneck stutter). `git lfs pull` fixes that.
- Building CEF yourself is only needed to change the patches or to move to a new CEF version. That is a full Chromium build: around 100 GB of disk and several hours. The two patches in [`patches/`](/patches) are small plain diffs against `chromium/src`, the README there says which version they apply to.
- When the `cef` crate version changes, the DLL has to be rebuilt for that version first (or deleted, which falls back to stock). A mismatched DLL crashes on start.

### Server

Only needed when you work on the server itself.

1. `cd server`
2. `bun i`
3. `bun run generate-config` (generates/copies the default configuration file)
4. `bun run start:dev` (watch mode, port 3030, its own database `data/kute.dev.db`, loose rate limits)

- Settings: [`config/config.template.ts`](/server/config/config.template.ts) holds the defaults. Put overrides (port, clan tag colors) in an untracked `config/config.custom.ts` of the same shape.
- `bun run start:prod` runs it the way the VPS does (PM2 uses [`pm2.ecosystem.json`](/server/pm2.ecosystem.json)).
- A client started with `bun run dev` sends its Auto-Detect reports to `127.0.0.1:3030` and never to the real server.
- Lint and typecheck run from the repo root, see above.

<hr>

## :octocat: Credits

- [slavcpglorp](https://github.com/slavcp/glorp) - base
- [6ct/client-pp](https://github.com/6ct/clientpp) - flags
- [KraXen72/crankshaft](https://github.com/KraXen72/crankshaft) - menu timer css
- [idkr-client/idkr](https://github.com/idkr-client/idkr) - tweaks
- [bigjakk/Electron-Websocket-Fix](https://github.com/bigjakk/Electron-Websocket-Fix) - aim-freeze fix

<hr>
