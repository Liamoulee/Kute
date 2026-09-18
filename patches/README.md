# Chromium patches for Kute's CEF build

You do not need these to build Kute. The patched `libcef.dll` ships in `resources/cef/` (Git LFS) and the build copies it over the stock one. They are here so everybody can see what the DLL changes, and to rebuild it for a new CEF version.

Plain `git diff` files against `chromium/src` at 151.0.7922.174 (CEF branch 7922, the version of the `cef` crate in `Cargo.toml`). Apply them after CEF's `genprojects.bat`, then build CEF the regular way (`automate-git.py`, around 100 GB of disk and several hours).

- `01-input-priority.patch`: `main_thread_scheduler_impl.cc`. Input task queues run at normal instead of highest priority and the compositor priority is capped at normal. Without it, continuous mouse input with `--disable-frame-rate-limit` starves WebSocket and worker messages on a busy main thread (the Krunker "aim freeze", Chromium bug 415071737). From bigjakk/Electron-Websocket-Fix.
- `02-frame-pacing.patch`: `cc/scheduler/scheduler_state_machine.cc`. `IsDrawThrottled()` no longer exempts `disable_frame_rate_limit`, so the renderer stops flooding the main thread with back to back BeginMainFrames. This is what fixes the stutter when the GPU is the limit. Queue depth is the feature param `CustomMaxPendingFrames:count/N` (default 1). From thegu5 and bigjakk.

Only comments differ from the source the shipped DLL was built with.
