use std::os::windows::ffi::OsStrExt;
use windows::{
    Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW},
    core::*,
};

use crate::{debug_print, utils};

// gpu subprocess only: load the DXGI hook before chromium creates its swap chain.
// the DLL exports render_attach so the hooks are installed synchronously instead of racing from DllMain
pub fn load() {
    // a bench run decides the hook through the environment instead of the user's setting
    if !crate::modules::bench::hook_override().unwrap_or_else(|| utils::config("hardFlip", true)) {
        debug_print!("render_hook: hardFlip disabled, gpu process runs the stock swapchain");
        return;
    }
    let path = utils::exe_dir().join("render.dll");
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let module = match LoadLibraryW(PCWSTR(wide.as_ptr())) {
            Ok(module) => module,
            Err(e) => {
                debug_print!("render_hook: LoadLibraryW failed: {e}");
                return;
            }
        };
        let Some(attach) = GetProcAddress(module, s!("render_attach")) else {
            debug_print!("render_hook: render.dll has no render_attach export");
            return;
        };
        let attach: unsafe extern "system" fn() -> i32 = std::mem::transmute(attach);
        let _result = attach();
        debug_print!("render_hook: render_attach returned {_result}");
    }
}
