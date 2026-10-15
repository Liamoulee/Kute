// present stats on linux (egl/vulkan interposer). the fps limit is held by chromium itself (patches 08 and 09)
pub fn load() {
    crate::debug_print!("render_hook: no present hook on linux");
}
