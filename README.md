![GitHub Downloads](https://img.shields.io/github/downloads/NullDev/Kute/total?label=Downloads) [![License](https://img.shields.io/github/license/NullDev/Kute?label=License&logo=Creative%20Commons)](https://github.com/NullDev/Kute/blob/master/LICENSE)

<p align="center"><img height="250" width="auto" src="/resources/icon.png" /></p>
<p align="center"><b>A high-performance Krunker client with enhanced features - made by <code>[cute]</code></b></p>
<hr>

## :arrow_down: Download

- [Latest Release](https://github.com/NullDev/Kute/releases/latest)
- [All Releases](https://github.com/NullDev/Kute/releases)

<hr>

## :star: Features

- [x] **Proper** Raw input
- [x] Increased performance
- [x] Hook DXGI parameters in an attempt of lowering latency
- [x] Optimized URL blocklist (only ~50 entries, fully customizable)
- [x] Resource swapper
- [x] Custom script support
- [x] Account Manager
- [x] Queue ranked without the game open
- [x] Find out your real ping to the servers
- [x] CPU Throttler
- [x] Lightweight autoupdater
- [x] Basic shortcuts (F11 - toggle fullscreen, F6 new lobby)
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
