# :wrench: Building

## What is in this repo

| Path | What it is |
|---|---|
| [`src/`](/src) | The client itself, `kute.exe`: a Rust Win32 host that creates the window, embeds CEF, injects the JS bundle and handles input, updates, Discord, the account store and the IPC with the page. The same exe is also every Chromium subprocess. |
| [`src/frontend/`](/src/frontend) | The JS bundle injected into krunker.io (esbuild, one file, `target/bundle.js`). Every client feature that lives in the page is a module in [`modules/`](/src/frontend/modules), the settings come from [`src/cSettings.json`](/src/cSettings.json). |
| [`crates/render-dll`](/crates/render-dll) | `render.dll`, loaded into Chromium's GPU process: the DXGI present hook (flip swapchain, FPS limiter, frame stats) and the producer side of the OBS capture. |
| [`crates/obs-kute-capture`](/crates/obs-kute-capture) | The OBS plugin that shows the game through a shared texture. |
| [`resources/`](/resources) | Installer script (WiX), VC runtime, and the patched CEF DLL in [`resources/cef/`](/resources/cef) (Git LFS). |
| [`patches/`](/patches) | The Chromium patches the CEF DLL is built with, and how to rebuild it. |
| [`server/`](/server) | The server behind `kute.lol`: clan colors, the Kute badge presence and the anonymous Auto-Detect reports. Bun, Fastify, TypeScript, SQLite. Its own project with its own `package.json`. The client builds and runs without it, and plays the same when it is down. |

## Client

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
| `bun run start:dev` | Bundle, debug build with verbose logs, run |
| `bun run start:dev:realapi` | Debug build with verbose logs, run with the real API URL |
| `bun run start:prod` | Build and run with production settings |
| `bun run build` | Release build in `target/release` |
| `bun run package` | Release build with the auto-updater plus the MSI (`target/kute-setup-x86_64.msi`) |
| `bun run esbuild` | Only the JS bundle |
| `bun run lint` / `bun run typecheck` | ESLint and `tsc` over the client JS **and** the server TS |

## Do I have to build CEF?

**No.** The build downloads the official CEF 151 runtime on its own, and the patched `libcef.dll` comes out of Git LFS and is copied over the stock one by `postbuild.js`. Nothing to compile, nothing to configure.

- Cloned without Git LFS? The build notices the placeholder file, warns, and keeps the stock DLL. The client works, it just lacks the two fixes (aim freeze, GPU bottleneck stutter). `git lfs pull` fixes that.
- Building CEF yourself is only needed to change the patches or to move to a new CEF version. That is a full Chromium build: around 100 GB of disk and several hours. The two patches in [`patches/`](/patches) are small plain diffs against `chromium/src`, the README there says which version they apply to.
- When the `cef` crate version changes, the DLL has to be rebuilt for that version first (or deleted, which falls back to stock). A mismatched DLL crashes on start.

## Server

Only needed when you work on the server itself.

1. `cd server`
2. `bun i`
3. `bun run generate-config` (generates/copies the default configuration file)
4. `bun run start:dev` (watch mode, port 3030, its own database `data/kute.dev.db`, loose rate limits)

- Settings: [`config/config.template.ts`](/server/config/config.template.ts) holds the defaults. Put overrides (port, clan tag colors) in an untracked `config/config.custom.ts` of the same shape.
- `bun run start:prod` runs it the way the VPS does (PM2 uses [`pm2.ecosystem.json`](/server/pm2.ecosystem.json)).
- A client started with `bun run dev` sends its Auto-Detect reports to `127.0.0.1:3030` and never to the real server.
- Lint and typecheck run from the repo root, see above.
