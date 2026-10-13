# Chromium patches for Kute's CEF build

You do not need these to build Kute. The patched `libcef.dll` ships in `resources/cef/` (Git LFS) and the build copies it over the stock one. They are here so everybody can see what the DLL changes, and to rebuild it for a new CEF version.

Plain `git diff` files against `chromium/src` at 151.0.7922.174 (CEF branch 7922, the version of the `cef` crate in `Cargo.toml`), applied on top of CEF's own Chromium patches.

- `01-input-priority.patch`: `main_thread_scheduler_impl.cc`, feature `KuteInputNormalPriority` (off by default, Kute turns it on for the "Input at Normal Priority" setting). Input task queues run at normal instead of highest priority and the compositor priority is capped at normal. Without it, continuous mouse input with `--disable-frame-rate-limit` starves WebSocket and worker messages on a busy main thread (the Krunker "aim freeze", Chromium bug 415071737). With the feature off both functions run the stock code. From bigjakk/Electron-Websocket-Fix.
- `02-frame-pacing.patch`: `cc/scheduler/scheduler_state_machine.cc`, feature `KuteFramePacing` (off by default, Kute turns it on for the "Frame Pacing" setting). `IsDrawThrottled()` no longer exempts `disable_frame_rate_limit`, so the renderer stops flooding the main thread with back to back BeginMainFrames. This is what fixes the stutter when the GPU is the limit. Queue depth is the feature param `CustomMaxPendingFrames:count/N` (default 1), which stays enabled by default and only carries the number. With `KuteFramePacing` off and the count at 1 the function is stock. From thegu5 and bigjakk.
- `03-raw-input-movement.patch`: `ui/views/win/hwnd_message_handler.cc`, feature `KuteRawInputMovementOnly` (off by default, Kute turns it on in `src/app.rs`). The raw mouse path keeps the movement of every packet and takes no button state from raw input. Stock Chromium skips a packet whose only flag is a wheel step, and Kute used to drop every packet with a button change before Chromium read it, so the page would not see the button in move events. Both threw away the movement in that packet: 6 to 9 counts per click or release, right at the shot. Also reads a mouse packet with one `GetRawInputData` call into a stack buffer instead of a size query, a heap allocation and a second call. While the feature is on, `src/modules/input.rs` skips its own `WM_INPUT` filter; `--disable-features=KuteRawInputMovementOnly` in `user_flags.json` brings the old way back.

- `04-panner-per-quantum.patch`: `panner_handler.cc`, feature `KuteAudioPannerPerQuantum` with the param `quanta` (default 3), off by default, Kute turns it on for the "Fix Audio Stutters" setting. `panner.positionX.value = x` schedules an automation event, so a game that writes sound positions once per rendered frame keeps every panner on Chromium's sample accurate path, which recomputes azimuth, elevation and distance gain for every frame of every quantum. With the feature the panner stays on the per quantum path and is re-panned at most every `quanta` quanta (8 ms at 48 kHz), which also stops the HRTF kernel crossfade from running in every quantum. The angles a plain assignment produces are constant across a quantum anyway. Panning itself is unchanged: hard left, hard right and a one second sweep verified in an OfflineAudioContext.

- `05-audioparam-coalesce.patch`: `audio_param_handler.cc`, feature `KuteAudioParamCoalesce`, off by default. `setTargetAtTime`/`setValueAtTime` clamp their start time to `currentTime`, which stops while a context is suspended. Krunker's Howler suspends its context 30 s after its last sound (with `ambient_*` blocked that's most of a match) and the game keeps moving the listener with `setTargetAtTime` every frame, so every param gains one event per frame, all with the same time. `InsertEvent`'s overlap scan then walks the whole list on every call, and the list never shrinks. An event followed by another at the same time lasts zero time, so the patch replaces a trailing SetTarget when a SetTarget or SetValue with the same time arrives (and a trailing SetValue before another SetValue) instead of appending. A SetValue followed by a SetTarget stays, the SetTarget starts from that value.

- `06-canvas-buffer-cache.patch`: `third_party/blink/renderer/platform/graphics/gpu/drawing_buffer.cc`, feature `KuteCanvasBufferCache` with the param `count` (default 3), off by default, Kute turns it on in `src/app.rs`. WebGL keeps at most one spare color buffer on Windows (`kDefaultColorBufferCacheLimit = 1`, Fuchsia already uses 2 "to avoid reallocation", crbug.com/1087941). When the compositor hands two back at once, one is destroyed and a new shared image is created a frame later: on the orb bench scene 0.06 to 0.17 creations per frame, each a GPU allocation plus clear that shows up as a frame with 4x the GPU time. How often depends on the timing phase a launch settles into, which is why launches landed in a fast or a slow mode. Measured 2026-09-28 on the orb scene, same DLL, 8 launches each: off 1384 to 1626 FPS (1 % low 377 to 445), on 1970 to 2033 FPS (1 % low 693 to 1319), every launch in the fast mode. In a Krunker match the churn is ten times rarer (0.017 per frame) and FPS did not change measurably; it matters for the auto-detect client bench, which runs on the orb scene. Costs one or two extra canvas sized buffers of GPU memory.

- `07-high-qos-foreground.patch`: `base/process/process_win.cc`, feature `KuteHighQoSForeground`, off by default, Kute turns it on in `src/app.rs`. `Process::SetPriority` gave a foreground (`kUserBlocking`) process an unset EcoQoS state, which hands the decision back to Windows' heuristics, and those may throttle a windowless process such as the game's renderer (the host sets HighQoS on itself, but the browser overwrites the renderer's state from outside). With the feature a foreground process is set to explicit HighQoS (`ProcessPowerState::kDisabled`); background processes still get EcoQoS as before.

- `08-frame-limiter.patch`: `components/viz/service/display/display_scheduler.{h,cc}`, feature `KuteFrameLimiter`, off by default, Kute turns it on for the "Chromium FPS Limiter" setting. With `--disable-frame-rate-limit` an FPS cap had to be held elsewhere: the DXGI hook slept inside `Present` on the GPU thread (sleep plus a 1 ms spin per frame, and the whole wait spun once frames were under 2 ms: 1.65 cores of CPU at a 500 cap), and without the hook the bundle busy-waited on the game's main thread (every other task up to 11 ms late at a 240 cap). What the hook's sleep really did was delay the swap ack, and a pending swap is what keeps `DisplayScheduler` from drawing the next frame (`pending_swaps_`, the "Swap throttled" deadline mode). With the feature `DidReceiveSwapBuffersAck` holds the ack until the next deadline of the interval the host writes into its `KuteFrameTiming` mapping (`target_fps`, read live, the slider works), then runs the stock handling. Frames reach the screen on a fixed grid through the same state machine path as with the hook, no thread sits in `Present`, nothing spins: a precise `DeadlineTimer` covers all but the last 2 ms, a high resolution waitable timer the rest (a plain delayed task got its wake aligned, 1.7 ms late at 240). Measured against the hook's limiter: same pacing on the orb scene (p99 4.8 ms at 240, 2.5 ms at 500), 20 of 20 seconds at exactly 500 with the hook on and off, input age in the game page equal or slightly better (p99 5.2 vs 5.3 ms at 240, 2.9 vs 3.1 ms at 500), half the CPU of the old hook wait, and it works with the hook off and on any backend. Three earlier designs failed and are worth knowing: pacing the `BackToBackBeginFrameSource` halves the rate at 500 (the Display draws one tick after the renderer submits); holding the renderer's surface acks in `Display::DrawAndSwap` works for seconds and then drops to half rate, because a renderer that waits for its ack is a "pending surface" to the scheduler and which deadline mode it picks depends on interleaving. The host writes `limiter_mode` into the mapping so the hook skips its own wait while this paces (render-dll `LIMITER_VIZ`).

- `09-frame-limiter-linux.patch`: applies on top of 08, Linux only (`#elif BUILDFLAG(IS_LINUX)`, the Windows code is untouched). 08 reads the limit from a Windows file mapping and does its last 2 ms on a waitable timer, so on Linux the feature did nothing. Here the host's `KuteFrameTiming` block is POSIX shared memory (`shm_open("/KuteFrameTiming")`, created by `app.rs` before the GPU process starts, Kute runs without the sandbox), and the last 2 ms are an absolute `clock_nanosleep` on `CLOCK_MONOTONIC`, the clock `base::TimeTicks` uses on Linux. Not measured yet: pacing and input age need a real Linux session with a real GPU, WSLg presents through RDP.

- `10-present-stats-linux.patch`: new `components/viz/service/display/kute_present_stats.{h,cc}` plus three calls in `display.cc`, feature `KutePresentStats`, off by default, the Linux host always turns it on (`app.rs`). On Windows `render.dll`'s Present1 hook fills the host's `KuteFrameTiming` block with present statistics; Linux has no such hook, so viz writes the same fields itself: `frame_ns` and `fps` as a moving average (gaps over 250 ms restart it), `hook_state` ready, and on a host request (`stats_request` / `stats_ack`) the p50, p99 and maximum of the present intervals since the last request, all with render-dll's constants so auto-detect compares the same numbers on both platforms. A present is a frame `Display::DrawAndSwap` hands to `SwapBuffers`, after patch 08/09's pacing, the counterpart of `Present1`. The sort runs after the swap was issued, never in front of the frame. Each window has its own `Display`: the one that swaps keeps the statistics and another (a social popup) only takes over after 300 ms without a swap, render-dll's `MAIN_SILENT_MS`; displays under 200 px high never count. `arrive_p99_ns` stays 0, there is no wait in front of the swap. Code inside is Linux only (`BUILDFLAG(IS_LINUX)`), elsewhere the feature has nothing to map.

- `11-no-exclusive-bubble.patch`: `chrome/browser/ui/views/frame/browser_view.cc`, feature `KuteNoExclusiveAccessBubble`, off by default, the Linux host always turns it on (`app.rs`). On Linux the browser is a Chrome style Views browser, so Kute's F11 (`Window::set_fullscreen`) goes through Chrome's fullscreen controller, which shows the "Press Esc to exit full screen" bubble, and pointer lock shows "Press Esc to show your cursor". The bubble is a separate window over the game: while it shows, Wayland and X11 compositors (Hyprland, KWin) give the game no direct scanout and no tearing (player report 2026-10-07, the first seconds after F11 played with more latency). With the feature `UpdateExclusiveAccessBubble` takes the path it already has for trusted pinned mode: no bubble, a shown one is closed. Esc handling itself is untouched. Not applied to the Windows DLL: the Win32 host makes its own window fullscreen and the browser never knows.

- `12-libcef-thinlto-max.patch`: `cef/BUILD.gn` (CEF's own repo, not Chromium), no feature switch, build-time only. The `libcef` target links with Chromium's `thinlto_optimize_default` config, which runs the ThinLTO link step at optimization level 0 (`/opt:lldlto=0`); `chrome.dll` itself takes `thinlto_optimize_max` (`/opt:lldlto=2`, cross-module inlining and optimization at link time). The patch gives libcef the same config. Relink only, about 10 minutes, the DLL grows from 288 to 304 MB. Measured 2026-10-13 on a 12900K/3090 Ti: orb bench scene +5 % frames with less CPU in four of four interleaved rounds, private Burg match with the host's input replay +6 to +13 % frames (1119/1151/1153 to 1252/1218/1299) with shorter frame tails in three of three rounds. Thorium's twelve extra `-mllvm` link flags on top measured below this alone, and a ThinLTO `import_instr_limit` of 100 instead of 30 measured within noise (two rounds up, two down), both dropped. The Linux `libcef.so` is relinked with it too.

Every patch is the exact diff of the tree the shipped DLL was built from. Since 2026-10-01 each one has a feature switch and a setting in Kute's Engine category (`src/app.rs::PATCHES` maps setting to feature), so a player and the auto-detect bench can turn any of them off: a `--disable-features=` line is pushed for a setting that is off, and Chromium lets the disable list win over `user_flags.json`.

## Rebuilding the DLL

What the shipped DLL was built with: CEF branch 7922, CEF commit `2384915b7b1f0fe5ad1107e48d80c34e86b698d7`, Chromium `151.0.7922.174` (`cef_binary_151.3.24+g2384915+chromium-151.0.7922.174`, the distribution `cef-dll-sys` downloads, see `Cargo.lock`). Windows x64, Visual Studio 2022 with ATL, Windows SDK 10.0.26100.0, Python 3.12, git with long paths, about 100 GB of disk. For a newer CEF, take the branch and commit from the tarball name `cef-dll-sys` downloads.

1. Environment for every step (cmd):

   ```
   set GN_DEFINES=is_official_build=true
   set GYP_MSVS_VERSION=2022
   set DEPOT_TOOLS_WIN_TOOLCHAIN=0
   set CEF_ARCHIVE_FORMAT=tar.bz2
   ```

2. Checkout with CEF's `automate-git.py` (from the CEF repo, `tools/automate/`), about 30 GB and 40 minutes. This fetches depot_tools, CEF and Chromium and applies CEF's own patches:

   ```
   py -3.12 automate-git.py --download-dir=C:\cef --branch=7922 --checkout=2384915b7b1f0fe5ad1107e48d80c34e86b698d7 --x64-build --no-chromium-history --with-pgo-profiles --no-build --no-distrib
   ```

3. Generate the build directories (with `C:\cef\depot_tools` on `PATH`): in `chromium\src\cef` run `python3.bat tools\gclient_hook.py`. Then append to `chromium\src\out\Release_GN_x64\args.gn`:

   ```
   symbol_level=0
   blink_symbol_level=0
   v8_symbol_level=0
   ```

4. Apply the patches in `chromium\src`, in order:

   ```
   git apply <kute>\patches\01-input-priority.patch
   git apply <kute>\patches\02-frame-pacing.patch
   git apply <kute>\patches\03-raw-input-movement.patch
   ...
   git apply <kute>\patches\12-libcef-thinlto-max.patch
   ```

   If one rejects on a new Chromium, the places to find are `MainThreadSchedulerImpl::ComputePriority` (the `kInput` case) and `ComputeCompositorPriority` (01), `SchedulerStateMachine::IsDrawThrottled` (02), `HWNDMessageHandler::OnInputEvent` (03), the `shared_library("libcef")` target's `configs` in `cef/BUILD.gn` (12, the file lives in the nested `cef` git repo, so save its diff with `git -C cef diff --src-prefix=a/cef/ --dst-prefix=b/cef/`). Save the re-anchored `git diff` back into this folder.

5. Build (with `C:\cef\depot_tools` on `PATH`, in `chromium\src`), about 3 hours from scratch on a 12900K, one to two minutes for a small change afterwards:

   ```
   autoninja -C out\Release_GN_x64 cefclient bootstrap bootstrapc
   ```

6. Copy `chromium\src\out\Release_GN_x64\libcef.dll` to `resources\cef\libcef.dll` and commit it (Git LFS). Only `libcef.dll` differs from the official distribution; `v8_context_snapshot.bin` and `icudtl.dat` come out byte identical, so the rest stays stock.

A `libcef.dll` that does not match the `cef` crate version crashes on start: when bumping the crate, rebuild first or delete `resources/cef/libcef.dll`.

## Rebuilding libcef.so (Linux)

Same CEF branch, commit and Chromium version as above. Built in a WSL2 Ubuntu 24.04 distro with 48 GB of memory and 32 GB of swap (`.wslconfig`), the tree on the distro's own disk, never under `/mnt/c`. The checkout took 9 minutes and 30 GB.

1. Environment for every step:

   ```
   export GN_DEFINES="use_sysroot=true is_official_build=true proprietary_codecs=true ffmpeg_branding=Chrome symbol_level=0 blink_symbol_level=0 v8_symbol_level=0"
   export CEF_ARCHIVE_FORMAT=tar.bz2
   ```

   `use_sysroot=true` builds against Chromium's Debian bullseye sysroot like CEF's own releases (old glibc, runs on older distros). Without it GN looks for the host's development packages and stops at the first missing one (`libpipewire-0.3`).

2. Checkout with the same `automate-git.py` call as on Windows (`--download-dir=$HOME/cef`, no `py -3.12`), then `sudo build/install-build-deps.sh --no-prompt --no-arm --no-nacl --no-chromeos-fonts` and `python3 build/linux/sysroot_scripts/install-sysroot.py --arch=amd64` in `chromium/src`.

3. Apply 01, 02, 04, 05, 06, 08, 09, 10 and 11 in `chromium/src`. 03 and 07 only touch Windows files and are left out, so `KuteRawInputMovementOnly` and `KuteHighQoSForeground` do not exist in this build. 12 applies on Linux too (`-Wl,--lto-O2` there, the relink took 15 minutes in WSL2, stripped 282 to 299 MB); the shipped `libcef.so` has it since 2026-10-13, checked in WSLg: page loads, limit 60 gives 60 fps (p50 16.7 ms), uncapped 109 (RDP presents, no performance number possible there).

4. In `chromium/src/cef` run `./cef_create_projects.sh`, then in `chromium/src`:

   ```
   autoninja -C out/Release_GN_x64 libcef
   ```

   1 h 45 min from scratch on a 12900K in WSL2 (63k steps), the link of `libcef.so` alone a few minutes.

5. `strip --strip-unneeded` the result (525 MB to 282 MB) into `resources/cef-linux/libcef.so` and commit it (Git LFS). `postbuild.js` copies `resources/cef-linux/` over the stock runtime on Linux, `resources/cef/` on Windows.

Checked in WSLg (2026-10-05): every Linux feature name is in the binary, `KuteRawInputMovementOnly` is not. With a limit of 30 and 60 the game page ran at exactly 30 and 60 FPS (median frame 33.3 and 16.7 ms), the stock `libcef.so` with the same flags at 348 and 251. WSLg cannot say anything about pacing or latency.

## How the patches were checked

- 01 and 02: the aim freeze stress test (a 12 s mouse flood over CDP on a page that spends 3 ms of JavaScript per frame, next to a 60 Hz WebSocket). Stock CEF freezes WebSocket delivery for 7 to 12 s, the patched DLL keeps every gap under about 36 ms, with no frame rate cost.
- 04: the audio thread's own time per second of audio, from Chromium's `webaudio` trace events, with 48 moving HRTF voices
  and a fixed 300 position writes a second, interleaved with a restart per configuration. Off: 407.6 and 309.6 ms/s. On:
  139.6 and 137.9 ms/s. `PannerHandler::Process` went from 18.8 us per quantum to 7.9.
- 05: `C:\cef\harnessudioparam-equiv.html` renders 16 automation scripts offline (ramps, curves, cancels, cancel and hold, suspend and resume, same-time piles, the value setter, an HRTF panner moved like Howler does), each also without its same-time duplicates. With the feature off the patched DLL is bit-identical to stock in all of them. With it on, the scripts without duplicates stay bit-identical, and every script with duplicates renders bit-identical to stock rendering the same script without them. Stock itself deviates there: a pile of same-time SetTargets after a SetValue loses the SetValue, while one SetTarget keeps it. Chromium's AudioParam, Panner, AudioListener and ConstantSource web tests (94 files, 2461 subtests, `wpt-run.mjs`): same results in all three configurations (one subtest fails in stock too and has an expected file upstream). 200k calls into a suspended context: stock 9.5 ms per 10k calls growing to 773, patched a flat 3. In a match, idle with the context suspended: uncapped FPS stayed at 1480 to 1520 for 150 s (stock fell from 1600 to about 550); capped at 240 the main thread stayed at 28 % busy for 229 s (stock reached 96 % at 214 s).
- 03: raw mouse counts against the movement the page received over the same 60 s in a match: 99.88 % with the patch, 99.65 % without (the difference is what the old filter dropped), presses and releases identical. The aim freeze test still passes with it (worst gaps 20.6 and 24.5 ms, stock 7.4 and 8.3 s in the same session).
- 06: orb bench scene (the auto-detect client bench), same DLL with the feature off and on through `user_flags.json`, 8 alternating launches each: off 1384 to 1626 FPS (median 1583), 1061 to 1495 frames over twice the median per 8 s, 1 % low 377 to 445; on 1970 to 2033 FPS (median 2009), 3 to 187 such frames, 1 % low 693 to 1319. A Chromium trace of fast and slow launches (event counts per presented frame on the GPU main thread) showed `SharedImageStub::OnCreateSharedImage`/`OnDestroySharedImage` as the only difference, 0.056 vs 0.169 per frame. In a private match: 0.017 per frame, FPS unchanged within noise (1375 to 1490 both ways). Enabled by default in a build: 3 of 3 launches 1963 to 2031 FPS.
- 07: measured neutral on an i9-12900K (forcing HighQoS on renderer and GPU process from outside changed nothing, 1480 FPS either way); it is a safety net for PCs where Windows would otherwise guess EcoQoS. Checked with GetProcessInformation(ProcessPowerThrottling) on every client process: the game's renderer reports explicit HighQoS, background renderers keep EcoQoS.
- 11: in WSLg (X11), page fullscreen over CDP with a user gesture: the old `libcef.so` maps a 422x51 window for the bubble that stays for the 7.5 s watched, the new one maps none, and the new one with `--disable-features=KuteNoExclusiveAccessBubble` maps it again. Page FPS old against new, three interleaved launches each: 101, 136, 107 against 97, 98, 99 (WSLg, presents through RDP; the code only runs when a bubble would change). Pointer lock could not be tested in WSLg, the window does not get focus. Direct scanout and tearing themselves need a real Hyprland or KWin session.
