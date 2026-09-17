![GitHub Downloads](https://img.shields.io/github/downloads/NullDev/Kute/total?label=Downloads) [![License](https://img.shields.io/github/license/NullDev/Kute?label=License&logo=Creative%20Commons)](https://github.com/NullDev/Kute/blob/master/LICENSE)

<p align="center"><img height="250" width="auto" src="/resources/icon.png" /></p>
<p align="center"><b>A high-performance Krunker client with enhanced features - made by <code>[cute]</code></b></p>
<hr>

## :arrow_down: Download

- [Latest Release](https://github.com/NullDev/Kute/releases/latest)
- [All Releases](https://github.com/NullDev/Kute/releases)

<hr>

## :star: Features

- [x] Runs on its own bundled Chromium (CEF), no browser or runtime install needed
- [x] Uncapped FPS with a DXGI present hook: waitable flip swapchain, frame pacing, present FPS counter and limiter
- [x] **Proper** Raw input
- [x] Selectable graphics backend (ANGLE: D3D11, D3D11on12, OpenGL, Vulkan) and color profile
- [x] Optimized URL blocklist (only ~50 entries, fully customizable), custom Chromium flags
- [x] Resource swapper
- [x] Custom script support
- [x] OBS capture plugin (shared texture game capture plus a dedicated audio window)
- [x] Account Manager
- [x] Queue ranked without the game open
- [x] Find out your real ping to the servers
- [x] Better chat, hardpoint enemy counter, rank progress
- [x] Discord Rich Presence
- [x] CPU Throttler
- [x] Lightweight autoupdater
- [x] Basic shortcuts (F11 - toggle fullscreen, F6 new lobby, F12 devtools)
- [x] and more...

<hr>

## :lock: Potential issues

If in a GPU bottleneck, the amount of frames displayed will drop severely, but the game's render loop won't slow down, this results in the client being almost unusable. <br>
Consider using the CPU Throttler in such scenario

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

- [glorp](https://github.com/slavcp/glorp) - base
- [client-pp](https://github.com/6ct/clientpp) - flags
- [crankshaft](https://github.com/KraXen72/crankshaft) - menu timer css

<hr>
