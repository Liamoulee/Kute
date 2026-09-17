use cef::{rc::*, *};
use std::{
    cell::RefCell,
    net::{IpAddr, Ipv4Addr},
    sync::{LazyLock, Mutex},
    time,
};

use crate::{bridge, modules::devtools};

static LAST_CONNECTED_LOBBY: LazyLock<Mutex<IpAddr>> = LazyLock::new(|| Mutex::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));

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

            if let Ok(ips) = dns_lookup::lookup_host(host)
                && let Some(ip) = ips.into_iter().next()
            {
                *LAST_CONNECTED_LOBBY.lock().unwrap() = ip;
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
        let addr = *LAST_CONNECTED_LOBBY.lock().unwrap();
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
