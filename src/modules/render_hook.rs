use std::os::windows::ffi::OsStrExt;
use windows::{
    Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW},
    core::*,
};

use crate::{debug_print, utils};

// gpu process only, before the first swap chain. render_attach instead of DllMain so nothing races
pub fn load() {
    // bench overrides the setting through the env
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
