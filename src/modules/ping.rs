use cef::{rc::*, *};
use std::{
    cell::RefCell,
    collections::HashMap,
    net::{IpAddr, Ipv4Addr},
    sync::Mutex,
    time,
};

use crate::{bridge, modules::devtools};

// the lobby the game connected to: its host name, and its address once the ping thread resolved it
static LAST_CONNECTED_LOBBY: Mutex<Option<(String, Option<IpAddr>)>> = Mutex::new(None);

// the observer is dropped when its registration is
thread_local! {
    static REGISTRATIONS: RefCell<Vec<Registration>> = const { RefCell::new(Vec::new()) };
}

// replaces GetDevToolsProtocolEventReceiver: remember the lobby the game connected to
wrap_dev_tools_message_observer! {
    struct LobbyObserver;

    impl DevToolsMessageObserver {
        fn on_dev_tools_event(&self, _browser: Option<&mut Browser>, method: Option<&CefString>, params: Option<&[u8]>) {
            let (Some(method), Some(params)) = (method, params) else { return };
            if method.to_string() != "Network.webSocketCreated" {
                return;
            }

            let Ok(json) = serde_json::from_slice::<serde_json::Value>(params) else { return };
            let Some(url) = json.get("url").and_then(|u| u.as_str()) else { return };
            if !url.contains("lobby-") {
                return;
            }

            let Some(host) = url.split("://").nth(1).and_then(|s| s.split('/').next()) else { return };
            let host = host.split(':').next().unwrap_or(host);

            // no DNS lookup here, this runs on the browser's UI thread. the ping thread resolves it
            let mut lobby = LAST_CONNECTED_LOBBY.lock().unwrap();
            if lobby.as_ref().is_none_or(|(known, _)| known != host) {
                *lobby = Some((host.to_string(), None));
            }
        }
    }
}

pub fn load(browser: &Browser) {
    devtools::enable_network(browser);
    let Some(host) = browser.host() else { return };
    let mut observer = LobbyObserver::new();
    if let Some(registration) = host.add_dev_tools_message_observer(Some(&mut observer)) {
        REGISTRATIONS.with_borrow_mut(|r| r.push(registration));
    }
}

// pinged off the UI thread so a timeout never stalls the browser
pub fn ping(browser_id: i32) {
    std::thread::spawn(move || {
        let Some(addr) = lobby_address() else { return };
        let result = ping_rs::send_ping(
            &addr,
            time::Duration::from_secs(1),
            Default::default(),
            Some(&ping_rs::PingOptions { ttl: 128, dont_fragment: true }),
        );
        if let Ok(reply) = result {
            bridge::post_json_later(browser_id, format!("{{\"pingInfo\":{}}}", reply.rtt));
        }
    });
}

// before the game connected anywhere this is localhost, like it always was
fn lobby_address() -> Option<IpAddr> {
    let lobby = LAST_CONNECTED_LOBBY.lock().unwrap().clone();
    let Some((host, resolved)) = lobby else {
        return Some(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)));
    };
    if resolved.is_some() {
        return resolved;
    }
    let ip = dns_lookup::lookup_host(&host).ok()?.next()?;
    let mut lobby = LAST_CONNECTED_LOBBY.lock().unwrap();
    // the game may have moved on to another lobby during the lookup
    if let Some((known, resolved)) = lobby.as_mut()
        && *known == host
    {
        *resolved = Some(ip);
    }
    Some(ip)
}

// the last region pings as a JSON object and when they were taken
static REGION_PINGS: Mutex<Option<(time::Instant, String)>> = Mutex::new(None);
const REGION_PINGS_MAX_AGE: time::Duration = time::Duration::from_secs(60);

pub fn ping_regions(browser_id: i32) {
    std::thread::spawn(move || {
        let cached = REGION_PINGS.lock().unwrap().as_ref().filter(|(at, _)| at.elapsed() < REGION_PINGS_MAX_AGE).map(|(_, json)| json.clone());
        let json = cached.unwrap_or_else(|| {
            let json = measure_region_pings();
            if json != "{}" {
                *REGION_PINGS.lock().unwrap() = Some((time::Instant::now(), json.clone()));
            }
            json
        });
        bridge::post_json_later(browser_id, format!("{{\"regionPings\":{json}}}"));
    });
}

fn measure_region_pings() -> String {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(time::Duration::from_secs(5))).build().into();
    let servers: HashMap<String, String> = agent
        .get("https://matchmaker.krunker.io/ping-list?hostname=krunker.io")
        .call()
        .ok()
        .and_then(|response| response.into_body().read_to_string().ok())
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default();

    // every region at once, so the slowest one decides how long this takes
    let pings: Vec<_> = servers
        .into_iter()
        .map(|(region, address)| {
            std::thread::spawn(move || {
                let host = address.split(':').next()?;
                let ip = dns_lookup::lookup_host(host).ok()?.find(IpAddr::is_ipv4)?;
                // a second try, a single lost packet would sort the region last
                (0..2).find_map(|_| {
                    ping_rs::send_ping(&ip, time::Duration::from_millis(1500), Default::default(), Some(&ping_rs::PingOptions { ttl: 128, dont_fragment: true }))
                        .ok()
                        .map(|reply| (region.clone(), serde_json::Value::from(reply.rtt)))
                })
            })
        })
        .collect();

    let pings: serde_json::Map<String, serde_json::Value> = pings.into_iter().filter_map(|ping| ping.join().ok().flatten()).collect();
    serde_json::Value::Object(pings).to_string()
}
