# Chromium patches for Kute's CEF build

You do not need these to build Kute. The patched `libcef.dll` ships in `resources/cef/` (Git LFS) and the build copies it over the stock one. They are here so everybody can see what the DLL changes, and to rebuild it for a new CEF version.

Plain `git diff` files against `chromium/src` at 151.0.7922.174 (CEF branch 7922, the version of the `cef` crate in `Cargo.toml`), applied on top of CEF's own Chromium patches.

- `01-input-priority.patch`: `main_thread_scheduler_impl.cc`. Input task queues run at normal instead of highest priority and the compositor priority is capped at normal. Without it, continuous mouse input with `--disable-frame-rate-limit` starves WebSocket and worker messages on a busy main thread (the Krunker "aim freeze", Chromium bug 415071737). From bigjakk/Electron-Websocket-Fix.
- `02-frame-pacing.patch`: `cc/scheduler/scheduler_state_machine.cc`. `IsDrawThrottled()` no longer exempts `disable_frame_rate_limit`, so the renderer stops flooding the main thread with back to back BeginMainFrames. This is what fixes the stutter when the GPU is the limit. Queue depth is the feature param `CustomMaxPendingFrames:count/N` (default 1). From thegu5 and bigjakk.
- `03-raw-input-movement.patch`: `ui/views/win/hwnd_message_handler.cc`, feature `KuteRawInputMovementOnly` (off by default, Kute turns it on in `src/app.rs`). The raw mouse path keeps the movement of every packet and takes no button state from raw input. Stock Chromium skips a packet whose only flag is a wheel step, and Kute used to drop every packet with a button change before Chromium read it, so the page would not see the button in move events. Both threw away the movement in that packet: 6 to 9 counts per click or release, right at the shot. Also reads a mouse packet with one `GetRawInputData` call into a stack buffer instead of a size query, a heap allocation and a second call. While the feature is on, `src/modules/input.rs` skips its own `WM_INPUT` filter; `--disable-features=KuteRawInputMovementOnly` in `user_flags.json` brings the old way back.

- `04-panner-per-quantum.patch`: `panner_handler.cc`, feature `KuteAudioPannerPerQuantum` with the param `quanta` (default 3), off by default, Kute turns it on for the "Fix Audio Stutters" setting. `panner.positionX.value = x` schedules an automation event, so a game that writes sound positions once per rendered frame keeps every panner on Chromium's sample accurate path, which recomputes azimuth, elevation and distance gain for every frame of every quantum. With the feature the panner stays on the per quantum path and is re-panned at most every `quanta` quanta (8 ms at 48 kHz), which also stops the HRTF kernel crossfade from running in every quantum. The angles a plain assignment produces are constant across a quantum anyway. Panning itself is unchanged: hard left, hard right and a one second sweep verified in an OfflineAudioContext.

- `05-audioparam-coalesce.patch`: `audio_param_handler.cc`, feature `KuteAudioParamCoalesce`, off by default. `setTargetAtTime`/`setValueAtTime` clamp their start time to `currentTime`, which stops while a context is suspended. Krunker's Howler suspends its context 30 s after its last sound (with `ambient_*` blocked that's most of a match) and the game keeps moving the listener with `setTargetAtTime` every frame, so every param gains one event per frame, all with the same time. `InsertEvent`'s overlap scan then walks the whole list on every call, and the list never shrinks. An event followed by another at the same time lasts zero time, so the patch replaces a trailing SetTarget when a SetTarget or SetValue with the same time arrives (and a trailing SetValue before another SetValue) instead of appending. A SetValue followed by a SetTarget stays, the SetTarget starts from that value.

01 and 02 differ from the source the shipped DLL was built with in comments only; 03 is the exact diff.

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
   ```

   If one rejects on a new Chromium, the places to find are `MainThreadSchedulerImpl::ComputePriority` (the `kInput` case) and `ComputeCompositorPriority` (01), `SchedulerStateMachine::IsDrawThrottled` (02), `HWNDMessageHandler::OnInputEvent` (03). Save the re-anchored `git diff` back into this folder.

5. Build (with `C:\cef\depot_tools` on `PATH`, in `chromium\src`), about 3 hours from scratch on a 12900K, one to two minutes for a small change afterwards:

   ```
   autoninja -C out\Release_GN_x64 cefclient bootstrap bootstrapc
   ```

6. Copy `chromium\src\out\Release_GN_x64\libcef.dll` to `resources\cef\libcef.dll` and commit it (Git LFS). Only `libcef.dll` differs from the official distribution; `v8_context_snapshot.bin` and `icudtl.dat` come out byte identical, so the rest stays stock.

A `libcef.dll` that does not match the `cef` crate version crashes on start: when bumping the crate, rebuild first or delete `resources/cef/libcef.dll`.

## How the patches were checked

- 01 and 02: the aim freeze stress test (a 12 s mouse flood over CDP on a page that spends 3 ms of JavaScript per frame, next to a 60 Hz WebSocket). Stock CEF freezes WebSocket delivery for 7 to 12 s, the patched DLL keeps every gap under about 36 ms, with no frame rate cost.
- 04: the audio thread's own time per second of audio, from Chromium's `webaudio` trace events, with 48 moving HRTF voices
  and a fixed 300 position writes a second, interleaved with a restart per configuration. Off: 407.6 and 309.6 ms/s. On:
  139.6 and 137.9 ms/s. `PannerHandler::Process` went from 18.8 us per quantum to 7.9.
- 05: `C:\cef\harnessudioparam-equiv.html` renders 16 automation scripts offline (ramps, curves, cancels, cancel and hold, suspend and resume, same-time piles, the value setter, an HRTF panner moved like Howler does), each also without its same-time duplicates. With the feature off the patched DLL is bit-identical to stock in all of them. With it on, the scripts without duplicates stay bit-identical, and every script with duplicates renders bit-identical to stock rendering the same script without them. Stock itself deviates there: a pile of same-time SetTargets after a SetValue loses the SetValue, while one SetTarget keeps it. Chromium's AudioParam, Panner, AudioListener and ConstantSource web tests (94 files, 2461 subtests, `wpt-run.mjs`): same results in all three configurations (one subtest fails in stock too and has an expected file upstream). 200k calls into a suspended context: stock 9.5 ms per 10k calls growing to 773, patched a flat 3. In a match, idle with the context suspended: uncapped FPS stayed at 1480 to 1520 for 150 s (stock fell from 1600 to about 550); capped at 240 the main thread stayed at 28 % busy for 229 s (stock reached 96 % at 214 s).
- 03: raw mouse counts against the movement the page received over the same 60 s in a match: 99.88 % with the patch, 99.65 % without (the difference is what the old filter dropped), presses and releases identical. The aim freeze test still passes with it (worst gaps 20.6 and 24.5 ms, stock 7.4 and 8.3 s in the same session).
