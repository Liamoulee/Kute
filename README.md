![GitHub Downloads](https://img.shields.io/github/downloads/NullDev/Kute/total?label=Downloads) [![License](https://img.shields.io/github/license/NullDev/Kute?label=License&logo=Creative%20Commons)](https://github.com/NullDev/Kute/blob/master/LICENSE) [![Latest Release](https://img.shields.io/github/v/release/NullDev/Kute?style=flat&label=Latest)](https://github.com/NullDev/Kute/releases/latest) [![release](https://github.com/NullDev/Kute/actions/workflows/release.yml/badge.svg)](https://github.com/NullDev/Kute/actions/workflows/release.yml) [![Server Deploy](https://github.com/NullDev/Kute/actions/workflows/deploy-server.yml/badge.svg)](https://github.com/NullDev/Kute/actions/workflows/deploy-server.yml) [![GitHub closed issues](https://img.shields.io/github/issues-closed-raw/NullDev/Kute?logo=Cachet)](https://github.com/NullDev/Kute/issues?q=is%3Aissue+is%3Aclosed)

<p align="center"><img height="250" width="auto" src="/resources/icon.png" /></p>
<p align="center"><b>A high-performance Krunker client with enhanced features - made by <code>[cute]</code></b><br><a href="https://kute.lol">https://kute.lol</a></p>
<hr>

## :arrow_down: Download

- [Download the latest installer](https://github.com/NullDev/Kute/releases/latest/download/kute-setup-x86_64.msi)
- [Download for Linux (AppImage)](https://github.com/NullDev/Kute/releases/latest/download/kute-x86_64.AppImage) (`chmod +x kute-x86_64.AppImage`, then start it. Settings stay in `~/.config/kute`, it updates itself, see the Linux question in the FAQ below)
- [Download the portable zip](https://github.com/NullDev/Kute/releases/latest/download/kute-x86_64-portable.zip) (unpack anywhere and start `kute.exe`. Settings stay in `Documents\kute`, small updates still apply by themselves, a new client version opens the download page instead of installing)
- [Release notes](https://github.com/NullDev/Kute/releases/latest)
- [All Releases](https://github.com/NullDev/Kute/releases)

<hr>

## :sparkles: About

Kute is a high-performance Krunker client designed to enhance your gaming experience with features like uncapped FPS, optimized performance tweaks, custom scripts, and more. It runs on its own bundled Chromium (CEF) and provides a seamless, feature-rich environment for both casual and competitive players. Brought to you by <code>[cute]</code>, and the same guy who co-developed [idkr](https://github.com/idkr-client/idkr) and contributed to [glorp](https://github.com/slavcp/glorp).

> [!WARNING]
> This client uses patched CEF with Raw Input, which means mouse input is native: every bit of movement reaches the game, more accurately than on any other client. If you are used to playing on other clients, it might take a bit of time to get used to it.

<hr>

> [!NOTE]
> Was AI used in the development of this client? Yes, **but**: <br>
> I use Claude to help with faster development, documentation and testing. Every single line of code is audited by me, and the AI is not allowed to touch performance critical code, unless it's for a _really_ good reason. These are still handwritten. The models operate on very strict rules and guidelines, such as what to touch, how to test and benchmark changes, best practices, and everything is reviewed and tested by me in addition to that. As such, AI-Generated PRs will be [rejected](https://github.com/NullDev/Kute/blob/master/CONTRIBUTING.md). This is not a vibe-coded project. The website at kute.lol on the other hand was entirely designed by AI. Because I can't be bothered to do frontend dev.

<hr>

## :star: Features

- [x] Runs on its own bundled Chromium (CEF), no browser or runtime install needed
  - [x] Patched CEF: fixes the aim freeze and the GPU bottleneck stutter of uncapped clients
  - [x] Every Chromium patch is a switch in the Engine settings, so any of them can be turned off on a PC where it does not help
  - [x] Fix Audio Stutters (optional): sound that cuts out at high FPS costs the audio thread about 60 % less
- [x] Uncapped FPS with a DXGI present hook: waitable flip swapchain, frame pacing and a present FPS counter
- [x] Exact FPS limiter inside Chromium's compositor (our patch): frames start on a fixed grid and reach the screen as soon as they are drawn
- [x] **Proper** Raw input (100%)
- [x] Increased performance tweaks (chromium & CEF flags, game settings, system optimizations)
- [x] Auto-Detect Best Settings: Client benchmarks your PC and automatically selects the optimal settings for performance and stability. Can be reverted at any time
- [x] Disable & hide all non-performance settings: one switch turns off every cosmetic feature and hides its settings, switch it back and your choices return
- [x] Laptops with two graphics chips are recognized: Kute picks the fast one in Windows' graphics settings once, and starts without the swapchain hook there. On Linux, NVIDIA PRIME render offload puts the game on the NVIDIA chip
- [x] Laptop Power Boost (optional): a plugged in laptop runs on Windows' Best performance mode while Kute is open, and gets its own mode back after
- [x] NVIDIA driver caps lifted for Kute only: its own driver profile
- [x] Selectable graphics backend (ANGLE: D3D11, D3D11on12, OpenGL, Vulkan) and color profile
- [x] Optimized URL blocklist (only ~50 entries, fully customizable), custom Chromium flags
- [x] Resource swapper with an in-client manager: shows which game files your swaps replace, drag'n'drop & built-in editor. CSS swaps apply instantly, and your swaps win over the built-in blocklist
- [x] Classic menu (optional): the Season 9 menu layout, with every new Season 10 button and feature still in it
- [x] Cleaner menu (optional): hides the store ad, live streams, featured maps, the "Popular Now" row and other promos in the menu, in the regular and the classic menu. The logo, every button and the match info stay
- [x] Custom CSS with a syntax highlighted editor and live preview, always applied on top of Krunker's own styles
- [x] Kute CSS (optional): Kute's own look for the whole client, menus, settings, every window and popup, the social window and the HUD, with a few cats. Colors that carry meaning (KR, rarities, teams, health) stay Krunker's, the classic menu keeps its buttons, and your Custom CSS still wins
- [x] Motion blur (optional): a slight blur while you turn the camera, the HUD stays sharp
- [x] Custom sky (optional): a built-in preset, your own color gradient or your own image as the sky of every map
- [x] All settings togglable
- [x] Export and import Kute's settings (client settings, HUD positions, matchmaker filters, hotkeys) as one file, for a second PC or a fresh install
- [x] Diagnostics Report (About settings): hardware, drivers, system load, Kute and Krunker settings, the last Auto-Detect run, recent errors and crash logs in one file to attach to an issue. You see every part first and can leave any out, user names and addresses are removed, nothing is uploaded
- [x] Safe mode and crash finder: after two crashes in a row Kute offers to start without your userscripts, swaps, custom CSS, flags and engine tweaks, or finds the cause by itself, restarting with parts switched off until it can name the one that crashes. Nothing of yours changes until you say so. Hold Shift while starting Kute (or start it with `--safe-mode`) for safe mode at any time
- [x] Battle pass claim-all
- [x] Userscripts (Crankshaft and idkr formats) with an in-client manager: live on/off, script settings, a built-in editor, drag and drop. New and edited scripts load without a refresh. Ships with example scripts, off by default: Class Roulette draws a random class on every respawn (Sharp Shooter in any mode), with a toggle per class and a "don't repeat the last N" option; Quick Sell by Rarity sells every quick sellable item of one rarity at once, with a preview of items and KR and a confirmation before anything is sold
- [x] Mod compatibility: mods, lobby and invite links open in the game window instead of a second one that would end your match
- [x] One-click mod download: a download button on every mod in Krunker's Mods window saves its zip to your Downloads folder
- [x] OBS capture plugin (shared texture game capture plus a dedicated audio window)
- [x] Officially supported by Medal.tv
- [x] Encrypted Account Manager: drag accounts into your order, Ctrl+Alt+1, 2 and 3 log in the first three (rebindable)
- [x] Kute Market (optional, on by default): a clear market overview, tabbed discovery with budget and activity filters, a local watchlist with price targets, inventory coverage, and side-by-side trade comparisons. Item searches suggest matches with thumbnails as you type. Native trade windows keep both inventories side by side, with a prominent trade verdict, a compact value comparison, and expandable evidence. A visual guide explains the colored liquidity grades. Both views offer price lines with dashed connections across missing observations, sampled asking-price candles with adaptive intervals and neutral single-quote ticks, comparisons, zoom, and reported sales bars. Advanced mode adds moving averages, RSI, volatility, drawdown, supply pressure, depth ladders, market diagnostics, and listing filters. Estimates show their evidence and quote freshness. Item details show the lowest and highest observed asks beside the estimate, separately from historical sale-price ranges. Market cards and trade windows link into the same tools. Analytics only: Kute never buys, lists, or trades for you.
- [x] Market Intelligence, inside Discover: experimental descriptive signals for unusual activity, changing supply, movement relative to similar items, concentrated listings and current spin/shop availability. Item pages, deal ranking and trade explanations share scheduled snapshots. Signal thresholds have not been validated as predictive alerts. A trained research model records seven-day price forecasts and exposes its historical and forward track record; price predictions remain hidden until accuracy and uncertainty checks pass. Official news and catalog changes are collected as context, without invented sentiment scores.
- [x] Match end message per account (optional): Krunker's end message is remembered for each account, so an alt never sends your main's message. An account without one sends nothing
- [x] Queue ranked without the game open
- [x] Better ranked with ELO system
- [x] Find out your real ping to the servers
- [x] Real pings in Find Game: every server shows its region's ping, and the old browser layout sorts regions fastest first
- [x] Ranked match alert (optional): when Krunker's ranked queue finds a match while you are tabbed out, Kute comes to the front or flashes in the taskbar
- [x] Matchmaker: F6 joins the lowest ping lobby that fits your filters (region, mode, map, players, time left), with starred modes and maps tried first in your order
- [x] Better chat
- [x] Chat logs: the last 2000 chat lines, kept across lobbies, to filter, search and copy (F1, rebindable)
- [x] Hardpoint enemy counter
- [x] Nuke counter: your career nuke total in game, with an optional goal
- [x] Keystrokes: your bound movement keys and mouse in the HUD, lit while pressed, with a ring that shows which way the mouse moves
- [x] HUD editor: drag, resize and hide every in-game HUD element and the menu timer, snapping included
- [x] Rank progress
- [x] Clan colors
- [x] Kute badge (one setting turns off every Kute online feature, nothing is sent then)
- [x] Kute icons: our own counter, ammo, hitmarker, reticle and scope icons, each one optional, without touching your settings
- [x] Discord Rich Presence
- [x] CPU throttler (a last resort, see below)
- [x] Autoupdater with a download progress window, plus changelogs
- [x] Rebindable kute hotkeys
- [x] Matchmaker
- [x] Spotify overlay - by [@Liamoulee](https://github.com/Liamoulee)
- [ ] BetterKDR™️ (coming soon)
- [x] and more...

<hr>

<p align="center">
If you want to support this Project, you can help with Code contributions :octocat: or a donation ❇️ <br> <br>
<a href="https://ko-fi.com/null_dev"><img src="https://ko-fi.com/img/githubbutton_sm.svg"></a>
</p>

<hr>

## :question: FAQ

<details>
<summary><b>My game stutters.</b></summary>
<br>

Run **Auto-Detect Best Settings** (General settings). It tests the client and plays a private test match by itself (don't touch mouse or keyboard for about two minutes), and only keeps what measurably runs better on your PC (it needs a Krunker account). Leave CPU Throttling at 1. Still stuttering? Save a **Diagnostics Report** (About settings) and attach it to [an issue](https://github.com/NullDev/Kute/issues/choose).

</details>

<details>
<summary><b>I can't aim / my aim feels different.</b></summary>
<br>

Kute uses pure raw input: your mouse's movement goes straight to the game, without Windows pointer acceleration, and none of it gets lost, not even the movement in the same instant as a click or a scroll. No other client passes every bit of it through. It is more accurate, and exactly because of that it can feel different for a few rounds if your aim is used to another client. Give it some time before you change your sensitivity.

</details>

<details>
<summary><b>Does Kute run on Linux?</b></summary>
<br>

Yes, as an [AppImage](https://github.com/NullDev/Kute/releases/latest/download/kute-x86_64.AppImage) for 64-bit Linux with glibc 2.35 or newer (Ubuntu 22.04, Debian 12, Fedora 36 and later, Arch). Make it executable and start it, nothing gets installed. A few things work differently there:

- It runs through X11 (XWayland in a Wayland session) by default, which runs much faster than native Wayland for now. Advanced settings, Display Server switches it.
- Linux applies your desktop's mouse acceleration to the game, Chromium has no raw input there yet. For raw input set your mouse to the **Flat** acceleration profile at speed **0** (KDE: System Settings, Mouse; GNOME: Settings, Mouse, Mouse Acceleration off).
- Not on Linux: the OBS capture plugin (OBS's PipeWire window capture records the game), the DXGI swapchain hook (the Present FPS Counter still works), the NVIDIA driver profile and the graphics backend choice.

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
> The server (`server/`) is **not** open source. Its code is published for reference only, all rights reserved (see [server/LICENSE](server/LICENSE)), so you may not run, host, copy or reuse it. Write your own. The GPL-3.0 license of this repository covers the client only.

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
- [bigjakk/Krunker-Civilian-Client](https://github.com/bigjakk/Krunker-Civilian-Client) - matchmaker, nuke counter, custom sky and keystrokes ideas
- [Alx8g/wok-client](https://github.com/Alx8g/wok-client) - motion blur idea
- [PC7 Client](https://github.com/PC7-Client/PC7-Client) - ideas (badges, QoL, etc.) 
- [Water Client](https://github.com/ghostypostie/Water) - ideas (direct mod downloads)
- [krunkerresourcehub/krh-client](https://github.com/krunkerresourcehub/krh-client) - ideas (Quick Alt-Login, Safe Mode)

<hr>
