![GitHub Downloads](https://img.shields.io/github/downloads/NullDev/Kute/total?label=Downloads) [![License](https://img.shields.io/github/license/NullDev/Kute?label=License&logo=Creative%20Commons)](https://github.com/NullDev/Kute/blob/master/LICENSE) [![Latest Release](https://img.shields.io/github/v/release/NullDev/Kute?style=flat&label=Latest)](https://github.com/NullDev/Kute/releases/latest) [![release](https://github.com/NullDev/Kute/actions/workflows/release.yml/badge.svg)](https://github.com/NullDev/Kute/actions/workflows/release.yml) [![Server Deploy](https://github.com/NullDev/Kute/actions/workflows/deploy-server.yml/badge.svg)](https://github.com/NullDev/Kute/actions/workflows/deploy-server.yml) [![GitHub closed issues](https://img.shields.io/github/issues-closed-raw/NullDev/Kute?logo=Cachet)](https://github.com/NullDev/Kute/issues?q=is%3Aissue+is%3Aclosed)

<p align="center"><img height="250" width="auto" src="/resources/icon.png" /></p>
<p align="center"><b>A high-performance Krunker client with enhanced features - made by <code>[cute]</code></b><br><a href="https://kute.lol">https://kute.lol</a></p>
<hr>

## :arrow_down: Download

- [Download the latest installer](https://github.com/NullDev/Kute/releases/latest/download/kute-setup-x86_64.msi)
- [Release notes](https://github.com/NullDev/Kute/releases/latest)
- [All Releases](https://github.com/NullDev/Kute/releases)

<hr>

## :sparkles: About

Kute is a high-performance Krunker client designed to enhance your gaming experience with features like uncapped FPS, optimized performance tweaks, custom scripts, and more. It runs on its own bundled Chromium (CEF) and provides a seamless, feature-rich environment for both casual and competitive players. Brought to you by <code>[cute]</code>, and the same guy who co-developed [idkr](https://github.com/idkr-client/idkr) and contributed to [glorp](https://github.com/slavcp/glorp).

> [!WARNING]
> This client uses patched CEF with Raw Input, which means mouse input is native: every bit of movement reaches the game, more accurately than on any other client. If you are used to playing on other clients, it might take a bit of time to get used to it.

<hr>

## :star: Features

- [x] Runs on its own bundled Chromium (CEF), no browser or runtime install needed
  - [x] Patched CEF: fixes the aim freeze and the GPU bottleneck stutter of uncapped clients
- [x] Uncapped FPS with a DXGI present hook: waitable flip swapchain, frame pacing, present FPS counter and an exact FPS limiter that keeps the CPU idle
- [x] **Proper** Raw input
- [x] Increased performance tweaks (chromium & CEF flags, game settings, system optimizations)
- [x] Auto-Detect: measures your PC in a private test match (about a minute) and sets up the game and the client for it, with undo
- [x] NVIDIA driver caps lifted for Kute only: its own driver profile (no Max Frame Rate, V-Sync left to the client) is created once, your global settings and other games stay as they are, and you can change or delete it in the NVIDIA Control Panel
- [x] Selectable graphics backend (ANGLE: D3D11, D3D11on12, OpenGL, Vulkan) and color profile
- [x] Optimized URL blocklist (only ~50 entries, fully customizable), custom Chromium flags
- [x] Resource swapper with an in-client manager: shows which game files your swaps replace, drop a file onto a game file to put it in the right place, folder names ignore case
- [x] All settings togglable
- [x] Battle pass claim-all
- [x] Userscripts (Crankshaft and idkr formats) with an in-client manager: live on/off, script settings, a built-in editor, drag and drop
- [x] Mod compatibility: mods, lobby and invite links open in the game window instead of a second one that would end your match
- [x] OBS capture plugin (shared texture game capture plus a dedicated audio window)
- [x] Officially supported by Medal.tv
- [x] Encrypted Account Manager
- [x] Queue ranked without the game open
- [x] Better ranked with ELO system
- [x] Find out your real ping to the servers
- [x] Matchmaker: F6 joins the lowest ping lobby that fits your filters (region, mode, map, players, time left)
- [x] Better chat
- [x] Hardpoint enemy counter
- [x] Nuke counter: your career nuke total in game, with an optional goal
- [x] HUD editor: drag, resize and hide every in-game HUD element, snapping included
- [x] Rank progress
- [x] Clan colors
- [x] Kute badge
- [x] Kute icons: our own counter, ammo, hitmarker, reticle and scope icons, each one optional, without touching your settings
- [x] Discord Rich Presence
- [x] CPU throttler (a last resort, see below)
- [x] Lightweight autoupdater & changelogs
- [x] Basic shortcuts (F4 new lobby, F6 matchmaker, F5 reload, F11 fullscreen, F12 devtools)
- [x] Matchmaker
- [ ] Skin Swapper (coming soon)
- [ ] BetterKDR™️ (coming soon)
- [ ] Bloomberg-style trading terminal & market analysis (coming soon)
- [ ] Spotify and YouTube Music overlay (coming soon)
- [ ] Custom CSS Manager (coming soon)
- [x] and more...

<hr>

<p align="center">
If you want to support this Project, you can help with Code contributions :octocat: or a donations ❇️ <br> <br>
<a href="https://ko-fi.com/null_dev"><img src="https://ko-fi.com/img/githubbutton_sm.svg"></a>
</p>

<hr>

## :question: FAQ

<details>
<summary><b>My game stutters.</b></summary>
<br>

Run **Auto-Detect Best Settings** (General settings). It plays a private test match, measures what each setting costs on your PC and sets only what makes a real difference (it needs a Krunker account). Leave CPU Throttling at 1 unless Auto-Detect sets it. Still stuttering? Open Auto-Detect's Advanced view, copy the report and [open an issue](https://github.com/NullDev/Kute/issues/choose).

</details>

<details>
<summary><b>I can't aim / my aim feels different.</b></summary>
<br>

Kute uses pure raw input: your mouse's movement goes straight to the game, without Windows pointer acceleration, and none of it gets lost, not even the movement in the same instant as a click or a scroll. No other client passes every bit of it through. It is more accurate, and exactly because of that it can feel different for a few rounds if your aim is used to another client. Give it some time before you change your sensitivity.

</details>

<details>
<summary><b>My FPS is lower than in other clients, but Kute feels smoother.</b></summary>
<br>

Uncapped, other clients count every frame the game computes, including frames that never reach your screen: they pile up behind the GPU and get replaced before they are shown. That makes a big number, but those extra frames are only extra load and extra input lag. Kute's swap chain hook and patched Chromium let the game run just one frame ahead, so it only computes frames that actually get shown, and the **Present FPS Counter** (Interface settings) shows the frames that reach your screen. A lower number that is real, instead of a higher one that is not.

</details>

<hr>

## :wrench: Building

See [BUILDING.md](BUILDING.md) for what is in this repo and how to build the client and the server.

<hr>

## :handshake: Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. In short:

- Issues labeled [`help wanted`](https://github.com/NullDev/Kute/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22help%20wanted%22) are the best place to start.
- Ask in an issue before working on a new feature. There is no guarantee it gets merged.
- All code must be audited and tested by a human. No AI generated or vibe coded PRs.
- Code must never make performance worse. Anything that costs performance goes behind a setting that is off by default, or does not get added.

> [!IMPORTANT]
> Standalone forks may **not** use the [kute.lol](https://kute.lol) website or its API. If you ship your own client based on Kute, point it at your own server.

**Contributors <3**

<a href="https://github.com/NullDev/Kute/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=NullDev/Kute&v=1" />
</a>

<sub>Made with [contrib.rocks](https://contrib.rocks).</sub>

<hr>

## :octocat: Credits

- [slavcp/glorp](https://github.com/slavcp/glorp) - base
- [6ct/client-pp](https://github.com/6ct/clientpp) - flags
- [KraXen72/crankshaft](https://github.com/KraXen72/crankshaft) - menu timer css
- [idkr-client/idkr](https://github.com/idkr-client/idkr) - tweaks
- [bigjakk/Electron-Websocket-Fix](https://github.com/bigjakk/Electron-Websocket-Fix) - aim-freeze fix
- [bigjakk/Krunker-Civilian-Client](https://github.com/bigjakk/Krunker-Civilian-Client) - matchmaker, nuke counter

<hr>
