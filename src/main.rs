#![cfg_attr(feature = "packaged", windows_subsystem = "windows")]
use cef::{args::Args, *};
use std::{
    env,
    sync::{LazyLock, Mutex},
};

mod app;
mod bridge;
mod config;
mod constants;
mod handlers;
#[cfg(target_os = "linux")]
mod linux;
mod renderer;
mod utils;
#[cfg(windows)]
mod window;
#[cfg(target_os = "linux")]
use linux::window;
pub mod modules {
    pub mod accounts;
    pub mod attest;
    pub mod bench;
    pub mod bisect;
    pub mod blocklist;
    pub mod custom_css;
    pub mod dev;
    pub mod devtools;
    pub mod diagnostics;
    #[cfg(windows)]
    pub mod dpapi;
    #[cfg(target_os = "linux")]
    pub use crate::linux::dpapi;
    pub mod eventlog;
    pub mod files;
    pub mod flaglist;
    #[cfg(windows)]
    pub mod gpu;
    #[cfg(target_os = "linux")]
    pub use crate::linux::gpu;
    pub mod hotkeys;
    pub mod icons;
    #[cfg(windows)]
    pub mod input;
    #[cfg(target_os = "linux")]
    pub use crate::linux::input;
    pub mod lifecycle;
    #[cfg(windows)]
    pub mod load;
    #[cfg(target_os = "linux")]
    pub use crate::linux::load;
    #[cfg(windows)]
    pub mod nvidia;
    #[cfg(target_os = "linux")]
    pub use crate::linux::nvidia;
    #[cfg(windows)]
    pub mod obs;
    #[cfg(target_os = "linux")]
    pub use crate::linux::obs;
    pub mod ping;
    #[cfg(windows)]
    pub mod power;
    pub mod recovery;
    #[cfg(target_os = "linux")]
    pub use crate::linux::power;
    #[cfg(windows)]
    pub mod priority;
    #[cfg(target_os = "linux")]
    pub use crate::linux::priority;
    #[cfg(windows)]
    pub mod render_hook;
    #[cfg(target_os = "linux")]
    pub use crate::linux::render_hook;
    #[cfg(windows)]
    pub mod replay;
    #[cfg(target_os = "linux")]
    pub use crate::linux::replay;
    pub mod resource;
    pub mod skybox;
    #[cfg(windows)]
    pub mod specs;
    #[cfg(target_os = "linux")]
    pub use crate::linux::specs;
    #[cfg(windows)]
    pub mod spotify;
    #[cfg(target_os = "linux")]
    pub use crate::linux::spotify;
    pub mod swapper;
    #[cfg(windows)]
    pub mod swapper_watch;
    #[cfg(windows)]
    pub mod updater;
    #[cfg(target_os = "linux")]
    pub use crate::linux::updater;
    pub mod userscripts;
    pub mod zip;
}

static LAUNCH_ARGS: LazyLock<Mutex<Vec<String>>> =
    LazyLock::new(|| Mutex::new(env::args().skip(1).filter(|arg| !modules::lifecycle::is_internal_arg(arg)).collect()));
static CONFIG: LazyLock<Mutex<config::Config>> = LazyLock::new(|| Mutex::new(config::Config::load()));
static JS_VERSION: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new("0.0.0".to_string()));

fn main() {
    // cef 151 rejects every struct without this handshake
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    if modules::obs::handle_cli_flags() || modules::dev::handle_cli_flags() {
        return;
    }

    // subprocesses are this exe with --type=<kind>
    if let Some(process_type) = utils::process_type() {
        modules::priority::apply_to_self();
        modules::priority::high_qos_self();
        // inherited from the browser
        if utils::has_arg("--raise-timer-frequency") {
            utils::raise_timer_frequency();
        }
        match process_type.as_str() {
            "gpu-process" => modules::render_hook::load(),
            // hidden window OBS captures game audio from
            "utility" if utils::has_arg("--utility-sub-type=audio.mojom.AudioService") => modules::input::spawn_audio_window_thread(),
            _ => {}
        }
    }

    let args = Args::new();
    let mut cef_app = app::KuteApp::new();
    let code = execute_process(Some(args.as_main_args()), Some(&mut cef_app), std::ptr::null_mut());
    if code >= 0 {
        std::process::exit(code);
    }
    std::sync::LazyLock::force(&modules::eventlog::START);

    let bench = modules::bench::config();
    if let Some(bench) = bench {
        modules::bench::prepare_environment(bench);
    } else {
        modules::lifecycle::wait_for_previous_instance();
        modules::lifecycle::register_instance();
        modules::recovery::start();
    }
    #[cfg(feature = "packaged")]
    {
        modules::lifecycle::set_panic_hook().ok();
        modules::updater::installer_cleanup().ok();
    }
    #[cfg(windows)]
    modules::lifecycle::set_crash_filter();

    if let Err(e) = app::init_fs() {
        eprintln!("failed to set all the files in place {}", e);
    }
    modules::userscripts::seed_shipped();
    // preload the swapper off the IO thread, bench doesn't need it
    if bench.is_none() {
        std::thread::spawn(|| {
            std::sync::LazyLock::force(&modules::swapper::SWAPS);
        });
        #[cfg(windows)]
        modules::swapper_watch::start();
    }

    // before cef starts, the driver reads the profile when the gpu process spawns
    if bench.is_none() {
        modules::nvidia::ensure_profile();
        // also before: the gpu process reads hardFlip and windows' gpu preference at its start
        modules::gpu::apply_hybrid_defaults();
        modules::power::boost();
    }
    app::create_frame_timing_mapping();
    app::load_flags();
    app::set_limiter_mode();
    if app::has_flag("--raise-timer-frequency") {
        utils::raise_timer_frequency();
    }
    app::prepare_profile();
    modules::priority::prefer_cache_cores();
    modules::priority::high_qos_self();

    let settings = app::settings();
    if initialize(Some(args.as_main_args()), Some(&settings), Some(&mut cef_app), std::ptr::null_mut()) != 1 {
        eprintln!("cef initialize failed");
        std::process::exit(1);
    }

    // main window gets created in on_context_initialized
    run_message_loop();
    debug_print!("main: message loop ended");
    shutdown();
    debug_print!("main: cef shut down");

    #[cfg(target_os = "linux")]
    app::remove_frame_timing_mapping();

    // bench must not overwrite lastPosition
    if bench.is_none() {
        modules::power::restore();
        CONFIG.lock().unwrap().save();
        modules::recovery::clean_exit();
    }
    #[cfg(feature = "auto-update")]
    modules::updater::install_pending();
}
