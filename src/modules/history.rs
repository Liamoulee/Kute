use cef::{rc::*, *};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
};

use crate::{bridge, modules::devtools, utils::config};

// reads the game's own market and trade replies over devtools, a fetch wrapper would be visible to krunker's cheat checks

const ORIGIN: &str = "https://gapi.svc.krunker.io";
// a list or trade request is a few hundred bytes, anything bigger is not one we read
const MAX_REQUEST_BODY: usize = 16 * 1024;

struct Pending {
    // the two replies bundles before market-capture read as marketHistory
    history: Option<&'static str>,
    method: String,
    path: String,
    request: Option<String>,
}

thread_local! {
    static ACTIVE: Cell<bool> = const { Cell::new(false) };
    static REGISTRATIONS: RefCell<Vec<Registration>> = const { RefCell::new(Vec::new()) };
    // request id of a read in flight, then the getResponseBody message id
    static REQUESTS: RefCell<HashMap<String, Pending>> = RefCell::new(HashMap::new());
    static BODIES: RefCell<HashMap<i32, Pending>> = RefCell::new(HashMap::new());
}

fn market_path(url: &str) -> Option<&str> {
    let path = url.strip_prefix(ORIGIN)?;
    (path.starts_with("/market/") || path.starts_with("/trades/")).then_some(path)
}

fn history_kind(method: &str, path: &str) -> Option<&'static str> {
    if method != "GET" {
        return None;
    }
    let base = path.split(['?', '#']).next().unwrap_or(path);
    match base {
        "/trades/history" => Some("trades"),
        "/market/history" => Some("sales"),
        _ => None,
    }
}

wrap_dev_tools_message_observer! {
    struct HistoryObserver;

    impl DevToolsMessageObserver {
        fn on_dev_tools_event(&self, browser: Option<&mut Browser>, method: Option<&CefString>, params: Option<&[u8]>) {
            let (Some(browser), Some(method), Some(params)) = (browser, method, params) else { return };
            // every game socket frame is a network event too, parse only the four we read
            let method = method.to_string();
            if !ACTIVE.get()
                || !matches!(
                    method.as_str(),
                    "Network.requestWillBeSent" | "Network.responseReceived" | "Network.loadingFailed" | "Network.loadingFinished"
                )
            {
                return;
            }
            let Ok(json) = serde_json::from_slice::<serde_json::Value>(params) else { return };
            let Some(id) = json.get("requestId").and_then(|v| v.as_str()) else { return };
            match method.as_str() {
                "Network.requestWillBeSent" => {
                    let request = &json["request"];
                    let Some(path) = request.get("url").and_then(|u| u.as_str()).and_then(market_path) else { return };
                    let verb = request.get("method").and_then(|m| m.as_str()).unwrap_or_default();
                    if !matches!(verb, "GET" | "POST") {
                        return;
                    }
                    let body = request.get("postData").and_then(|b| b.as_str()).filter(|b| b.len() <= MAX_REQUEST_BODY);
                    let pending = Pending {
                        history: history_kind(verb, path),
                        method: verb.to_string(),
                        path: path.to_string(),
                        request: body.map(str::to_string),
                    };
                    REQUESTS.with_borrow_mut(|r| {
                        // a read that never finishes must not pile up
                        if r.len() > 64 {
                            r.clear();
                        }
                        r.insert(id.to_string(), pending);
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
                    let Some(pending) = REQUESTS.with_borrow_mut(|r| r.remove(id)) else { return };
                    let message = devtools::get_response_body(browser, id);
                    crate::debug_print!("history: {} {} finished, reading body as message {message}", pending.method, pending.path);
                    BODIES.with_borrow_mut(|b| {
                        if b.len() > 64 {
                            b.clear();
                        }
                        b.insert(message, pending)
                    });
                }
                _ => {}
            }
        }

        fn on_dev_tools_method_result(&self, browser: Option<&mut Browser>, message_id: i32, success: i32, result: Option<&[u8]>) {
            let Some(pending) = BODIES.with_borrow_mut(|b| b.remove(&message_id)) else { return };
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
            crate::debug_print!("history: posting {} {} to the page ({} bytes)", pending.method, pending.path, text.len());
            if let Some(kind) = pending.history {
                bridge::post_json(browser, &serde_json::json!({ "marketHistory": { "kind": kind, "data": data } }).to_string());
            }
            let request = pending.request.and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok());
            let capture = serde_json::json!({ "marketCapture": { "method": pending.method, "path": pending.path, "request": request, "data": data } });
            bridge::post_json(browser, &capture.to_string());
        }
    }
}

fn wanted() -> bool {
    config("market", true) && !config("disableOnlineFeatures", false)
}

/// starts or stops the capture to match the settings, the network domain stays on once enabled
pub fn load(browser: &Browser) {
    let on = wanted();
    ACTIVE.set(on);
    if !on {
        REQUESTS.with_borrow_mut(|r| r.clear());
        return;
    }
    if REGISTRATIONS.with_borrow(|r| !r.is_empty()) {
        return;
    }
    devtools::enable_network(browser);
    let Some(host) = browser.host() else { return };
    let mut observer = HistoryObserver::new();
    if let Some(registration) = host.add_dev_tools_message_observer(Some(&mut observer)) {
        REGISTRATIONS.with_borrow_mut(|r| r.push(registration));
    }
}
