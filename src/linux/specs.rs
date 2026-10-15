use super::{gpu, power, sys};
use serde_json::{Value, json};
use x11rb::{
    connection::Connection,
    protocol::{
        randr::{ConnectionExt as _, ModeFlag},
        xproto::ConnectionExt as _,
    },
};

fn os_name() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|line| line.strip_prefix("PRETTY_NAME=").map(|name| name.trim_matches('"').to_string()))
        })
        .unwrap_or_else(|| "Linux".to_string())
}

fn session_type() -> String {
    std::env::var("XDG_SESSION_TYPE").unwrap_or_default()
}

fn ram_mb() -> u64 {
    sys::proc_field("/proc/meminfo", "MemTotal")
        .and_then(|value| value.split_whitespace().next()?.parse::<u64>().ok())
        .map(|kb| kb / 1024)
        .unwrap_or(0)
}

// randr, the client runs on x11 (xwayland in a wayland session, whose outputs carry the compositor's connector names).
// empty on native wayland without xwayland, the page then assumes 60 Hz
fn displays(window: u64, adapters: &[gpu::Adapter]) -> Option<Vec<Value>> {
    let (connection, screen) = x11rb::connect(None).ok()?;
    let root = connection.setup().roots.get(screen)?.root;
    let resources = connection.randr_get_screen_resources_current(root).ok()?.reply().ok()?;
    let primary = connection.randr_get_output_primary(root).ok()?.reply().map(|reply| reply.output).unwrap_or(0);
    // the window's center in root coordinates, 0 is no x11 window (native wayland)
    let center = u32::try_from(window).ok().filter(|&window| window != 0).and_then(|window| {
        let geometry = connection.get_geometry(window).ok()?.reply().ok()?;
        let origin = connection.translate_coordinates(window, root, 0, 0).ok()?.reply().ok()?;
        Some((
            origin.dst_x as i32 + geometry.width as i32 / 2,
            origin.dst_y as i32 + geometry.height as i32 / 2,
        ))
    });

    let mut displays = Vec::new();
    for crtc in &resources.crtcs {
        let Some(info) = connection
            .randr_get_crtc_info(*crtc, resources.config_timestamp)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
        else {
            continue;
        };
        let (Some(mode), Some(&output)) = (resources.modes.iter().find(|mode| mode.id == info.mode), info.outputs.first()) else {
            continue;
        };
        let Some(name) = connection
            .randr_get_output_info(output, resources.config_timestamp)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|output| String::from_utf8_lossy(&output.name).into_owned())
        else {
            continue;
        };
        let mut lines = mode.htotal as f64 * mode.vtotal as f64;
        if mode.mode_flags.contains(ModeFlag::DOUBLE_SCAN) {
            lines *= 2.0;
        }
        if mode.mode_flags.contains(ModeFlag::INTERLACE) {
            lines /= 2.0;
        }
        // whole hz like windows' dmDisplayFrequency, 179.98 counts as 180
        let hz = if lines > 0.0 { (mode.dot_clock as f64 / lines).round() } else { 0.0 };
        let hosts = center.is_some_and(|(x, y)| {
            (info.x as i32..info.x as i32 + info.width as i32).contains(&x) && (info.y as i32..info.y as i32 + info.height as i32).contains(&y)
        });
        displays.push(json!({
            "name": name,
            "width": info.width,
            "height": info.height,
            "hz": hz,
            "primary": info.outputs.contains(&primary),
            "hostsWindow": hosts,
            "adapter": adapters.iter().find(|adapter| adapter.outputs.contains(&name)).map(|adapter| adapter.card.pci.as_str()),
        }));
    }
    Some(displays)
}

pub fn collect(window: u64) -> Value {
    let (laptop, on_battery) = power::battery();
    let (user_flags, disabled_defaults) = crate::modules::flaglist::user_flag_names();
    let adapters = gpu::adapters();
    let displays = displays(window, &adapters).unwrap_or_default();
    let shown_on = displays
        .iter()
        .find(|display| display["hostsWindow"] == true)
        .and_then(|display| display["adapter"].as_str());
    let render = gpu::render_adapter();
    // frames get copied between two gpus. null: not enough known to say
    let hybrid = shown_on.zip(render.as_deref()).map(|(display, render)| display != render);
    json!({
        "platform": "linux",
        "osBuild": os_name(),
        "kernel": sys::read_trimmed("/proc/sys/kernel/osrelease"),
        "session": session_type(),
        "userFlags": user_flags,
        "disabledDefaults": disabled_defaults,
        "displays": displays,
        "gpus": adapters.iter().map(|adapter| json!({
            "name": adapter.name,
            "vramMb": adapter.vram_mb,
            "vendorId": adapter.card.vendor_id,
            "software": false,
            "luid": adapter.card.pci,
            "driver": adapter.card.driver,
        })).collect::<Vec<_>>(),
        "renderAdapter": render.as_deref().map(|pci| json!({
            "luid": pci,
            "name": adapters.iter().find(|adapter| adapter.card.pci == pci).map(|adapter| adapter.name.as_str()),
        })),
        "hook": crate::app::hook_state(),
        "hybrid": hybrid,
        // the render gpu is read from the gpu process' open device files, never guessed
        "hybridSource": if hybrid.is_some() { "observed" } else { "unknown" },
        "primeOffload": gpu::prime_offload(),
        "powerOverlay": power::overlay_name(),
        "cpu": {
            "name": sys::proc_field("/proc/cpuinfo", "model name"),
            "threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        },
        "ramMb": ram_mb(),
        "laptop": laptop,
        "onBattery": on_battery,
    })
}
