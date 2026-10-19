use cef::{rc::*, *};
use std::{cell::RefCell, collections::HashMap};

use crate::{bridge, modules::devtools, utils::config};

// the game's own completed history replies, read on the browser side like the lobby socket in ping.rs:
// a fetch wrapper in the page would be visible to krunker's cheat checks

const ORIGIN: &str = "https://gapi.svc.krunker.io";

thread_local! {
    static REGISTRATIONS: RefCell<Vec<Registration>> = const { RefCell::new(Vec::new()) };
    // request id of a history read in flight, then the getResponseBody message id, each with its kind
    static REQUESTS: RefCell<HashMap<String, &'static str>> = RefCell::new(HashMap::new());
    static BODIES: RefCell<HashMap<i32, &'static str>> = RefCell::new(HashMap::new());
}

fn kind_of(url: &str) -> Option<&'static str> {
    let path = url.strip_prefix(ORIGIN)?;
    for (prefix, kind) in [("/trades/history", "trades"), ("/market/history", "sales")] {
        if let Some(rest) = path.strip_prefix(prefix)
            && (rest.is_empty() || rest.starts_with('?') || rest.starts_with('#'))
        {
            return Some(kind);
        }
    }
    None
}

wrap_dev_tools_message_observer! {
    struct HistoryObserver;

    impl DevToolsMessageObserver {
        fn on_dev_tools_event(&self, browser: Option<&mut Browser>, method: Option<&CefString>, params: Option<&[u8]>) {
            let (Some(browser), Some(method), Some(params)) = (browser, method, params) else { return };
            let method = method.to_string();
            if !method.starts_with("Network.") {
                return;
            }
            let Ok(json) = serde_json::from_slice::<serde_json::Value>(params) else { return };
            let Some(id) = json.get("requestId").and_then(|v| v.as_str()) else { return };
            match method.as_str() {
                "Network.requestWillBeSent" => {
                    let request = &json["request"];
                    let Some(kind) = request.get("url").and_then(|u| u.as_str()).and_then(kind_of) else { return };
                    if request.get("method").and_then(|m| m.as_str()) != Some("GET") || !config("market", true) {
                        return;
                    }
                    REQUESTS.with_borrow_mut(|r| {
                        // a read that never finishes must not pile up
                        if r.len() > 32 {
                            r.clear();
                        }
                        r.insert(id.to_string(), kind);
                    });
                }
                "Network.responseReceived" => {
                    if json["response"].get("status").and_then(|s| s.as_i64()) != Some(200) {
                        REQUESTS.with_borrow_mut(|r| r.remove(id));
                    }
                }
                "Network.loadingFailed" => {
                    REQUESTS.with_borrow_mut(|r| r.remove(id));
                }
                "Network.loadingFinished" => {
                    let Some(kind) = REQUESTS.with_borrow_mut(|r| r.remove(id)) else { return };
                    let message = devtools::get_response_body(browser, id);
                    BODIES.with_borrow_mut(|b| b.insert(message, kind));
                }
                _ => {}
            }
        }

        fn on_dev_tools_method_result(&self, browser: Option<&mut Browser>, message_id: i32, success: i32, result: Option<&[u8]>) {
            let Some(kind) = BODIES.with_borrow_mut(|b| b.remove(&message_id)) else { return };
            let (Some(browser), Some(result)) = (browser, result) else { return };
            if success == 0 {
                return;
            }
            let Ok(reply) = serde_json::from_slice::<serde_json::Value>(result) else { return };
            let Some(body) = reply.get("body").and_then(|b| b.as_str()) else { return };
            let text = if reply.get("base64Encoded").and_then(|b| b.as_bool()) == Some(true) {
                use base64::Engine;
                let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(body) else { return };
                let Ok(text) = String::from_utf8(bytes) else { return };
                text
            } else {
                body.to_string()
            };
            // the page gets the parsed reply, never text it has to parse itself
            let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) else { return };
            bridge::post_json(browser, &serde_json::json!({ "marketHistory": { "kind": kind, "data": data } }).to_string());
        }
    }
}

pub fn load(browser: &Browser) {
    devtools::enable_network(browser);
    let Some(host) = browser.host() else { return };
    let mut observer = HistoryObserver::new();
    if let Some(registration) = host.add_dev_tools_message_observer(Some(&mut observer)) {
        REGISTRATIONS.with_borrow_mut(|r| r.push(registration));
    }
}
