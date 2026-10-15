use super::sys;
use crate::{debug_print, modules, utils::config};
use std::{
    fs,
    sync::{Mutex, Once},
    time::Duration,
};
use zbus::blocking::{Connection, Proxy};

// power-profiles-daemon, or tuned-ppd with the same api. the old name is what ppd before 0.20 registers
const DAEMONS: [(&str, &str); 2] = [
    ("org.freedesktop.UPower.PowerProfiles", "/org/freedesktop/UPower/PowerProfiles"),
    ("net.hadess.PowerProfiles", "/net/hadess/PowerProfiles"),
];

// a hold lives as long as the connection that took it, so a crash or kill puts the profile back by itself.
// that is why there is no restore marker in settings.json like on windows
static HOLD: Mutex<Option<(Connection, u32)>> = Mutex::new(None);

fn daemon(connection: &Connection) -> Option<Proxy<'_>> {
    DAEMONS.iter().find_map(|&(name, path)| {
        let proxy = Proxy::new(connection, name, path, name).ok()?;
        proxy.get_property::<String>("ActiveProfile").is_ok().then_some(proxy)
    })
}

// for the auto-detect report: "balanced", "performance", "power-saver"
pub fn overlay_name() -> Option<String> {
    let connection = Connection::system().ok()?;
    daemon(&connection)?.get_property("ActiveProfile").ok()
}

// (laptop, on battery) from /sys/class/power_supply
pub fn battery() -> (bool, bool) {
    let Ok(entries) = fs::read_dir("/sys/class/power_supply") else {
        return (false, false);
    };
    let mut laptop = false;
    let mut on_ac = false;
    let mut has_ac = false;
    for entry in entries.flatten() {
        let path = entry.path();
        match sys::read_trimmed(path.join("type")).as_deref() {
            Some("Battery") if sys::read_trimmed(path.join("scope")).as_deref() != Some("Device") => laptop = true,
            Some("Mains") => {
                has_ac = true;
                on_ac |= sys::read_trimmed(path.join("online")).as_deref() == Some("1");
            }
            _ => {}
        }
    }
    (laptop, laptop && has_ac && !on_ac)
}

// windows tells the window about unplugging, here nobody does
fn watch_power() {
    static WATCH: Once = Once::new();
    WATCH.call_once(|| {
        std::thread::spawn(|| {
            let mut last = battery();
            loop {
                std::thread::sleep(Duration::from_secs(5));
                let now = battery();
                if now != last {
                    last = now;
                    on_power_change();
                }
            }
        });
    });
}

// a plugged in laptop on the default "balanced" profile holds "performance" while kute runs
pub fn boost() {
    if modules::bench::active() {
        return;
    }
    let (laptop, on_battery) = battery();
    if laptop {
        watch_power();
    }
    if !config("laptopPowerBoost", true) || !laptop || on_battery {
        restore();
        return;
    }
    let mut hold = HOLD.lock().unwrap();
    if hold.is_some() {
        return;
    }
    let Ok(connection) = Connection::system() else { return };
    let cookie = {
        let Some(proxy) = daemon(&connection) else { return };
        // anything but the default is a profile the player picked on purpose
        if proxy.get_property::<String>("ActiveProfile").ok().as_deref() != Some("balanced") {
            return;
        }
        match proxy.call::<_, _, u32>("HoldProfile", &("performance", "Kute is running", "kute")) {
            Ok(cookie) => cookie,
            Err(_e) => {
                debug_print!("power: hold refused: {_e}");
                return;
            }
        }
    };
    debug_print!("power: holding performance, cookie {cookie}");
    *hold = Some((connection, cookie));
}

// the panic hook's way out too, so no blocking lock. true: nothing of ours is left
pub fn put_back() -> bool {
    let Ok(mut hold) = HOLD.try_lock() else { return false };
    if let Some((connection, cookie)) = hold.take() {
        // closing the connection releases it as well, the call only makes it immediate
        if let Some(proxy) = daemon(&connection) {
            let _ = proxy.call::<_, _, ()>("ReleaseProfile", &(cookie,));
        }
        debug_print!("power: released the performance hold");
    }
    true
}

pub fn restore() {
    put_back();
}

pub fn on_power_change() {
    if battery() == (true, false) { boost() } else { restore() }
}
