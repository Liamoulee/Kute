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
mod renderer;
mod utils;
mod window;
pub mod modules {
    pub mod accounts;
    pub mod bench;
    pub mod blocklist;
    pub mod custom_css;
    pub mod dev;
    pub mod devtools;
    pub mod dpapi;
    pub mod files;
    pub mod flaglist;
    pub mod icons;
    pub mod input;
    pub mod lifecycle;
    pub mod nvidia;
    pub mod obs;
    pub mod ping;
    pub mod priority;
    pub mod render_hook;
    pub mod resource;
    pub mod specs;
    pub mod spotify;
    pub mod swapper;
    pub mod userscripts;
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

    let bench = modules::bench::config();
    if let Some(bench) = bench {
        modules::bench::prepare_environment(bench);
    } else {
        modules::lifecycle::wait_for_previous_instance();
        modules::lifecycle::register_instance();
    }
    #[cfg(feature = "packaged")]
    {
        modules::lifecycle::set_panic_hook().ok();
        modules::lifecycle::installer_cleanup().ok();
    }

    if let Err(e) = app::init_fs() {
        eprintln!("failed to set all the files in place {}", e);
    }
    // preload the swapper off the IO thread, bench doesn't need it
    if bench.is_none() {
        std::thread::spawn(|| {
            std::sync::LazyLock::force(&modules::swapper::SWAPS);
        });
    }

    // before cef starts, the driver reads the profile when the gpu process spawns
    if bench.is_none() {
        modules::nvidia::ensure_profile();
    }
    app::create_frame_timing_mapping();
    app::load_flags();
    if app::has_flag("--raise-timer-frequency") {
        utils::raise_timer_frequency();
    }
    app::prepare_profile();

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

    // bench must not overwrite lastPosition
    if bench.is_none() {
        CONFIG.lock().unwrap().save();
    }
}
