![GitHub Downloads](https://img.shields.io/github/downloads/NullDev/Kute/total?label=Downloads) [![License](https://img.shields.io/github/license/NullDev/Kute?label=License&logo=Creative%20Commons)](https://github.com/NullDev/Kute/blob/master/LICENSE) [![Server Deploy](https://github.com/NullDev/Kute/actions/workflows/deploy-server.yml/badge.svg)](https://github.com/NullDev/Kute/actions/workflows/deploy-server.yml)

<p align="center"><img height="250" width="auto" src="/resources/icon.png" /></p>
<p align="center"><b>A high-performance Krunker client with enhanced features - made by <code>[cute]</code></b><br><a href="https://kute.lol">https://kute.lol</a></p>
<hr>

## :arrow_down: Download

- [Latest Release](https://github.com/NullDev/Kute/releases/latest)
- [All Releases](https://github.com/NullDev/Kute/releases)

<hr>

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

- Prerequisites:
  - [Rust & Cargo](https://rustup.rs/)
  - [Microsoft Visual C++](https://visualstudio.microsoft.com/downloads/)
  - [CMake](https://cmake.org/download/) and [Ninja](https://github.com/ninja-build/ninja/releases) (the CEF wrapper is built on the first build)
  - [Bun](https://bun.sh/)
  - [WiX 6 **(if packaging)**](https://github.com/wixtoolset/wix/releases)

1. `git clone https://github.com/NullDev/Kute.git`
2. `cd Kute`
3. `bun i`
4. `bun run dev`
5. `bun run build`

<hr>

## :octocat: Credits

- [slavcpglorp](https://github.com/slavcp/glorp) - base
- [6ct/client-pp](https://github.com/6ct/clientpp) - flags
- [KraXen72/crankshaft](https://github.com/KraXen72/crankshaft) - menu timer css
- [idkr-client/idkr](https://github.com/idkr-client/idkr) - tweaks
- [bigjakk/Electron-Websocket-Fix](https://github.com/bigjakk/Electron-Websocket-Fix) - aim-freeze fix

<hr>
