use cef::*;
use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};

// CDP message ids only need to be unique per browser
static NEXT_ID: AtomicI32 = AtomicI32::new(1);

fn call(browser: &Browser, method: &str, params: Option<DictionaryValue>) {
    let Some(host) = browser.host() else { return };
    let mut params = params;
    host.execute_dev_tools_method(NEXT_ID.fetch_add(1, Ordering::Relaxed), Some(&CefString::from(method)), params.as_mut());
}

static LAST_THROTTLE_BITS: AtomicU32 = AtomicU32::new(1.0f32.to_bits());

pub fn set_cpu_throttling(browser: &Browser, value: f32) {
    // dedupe identical rates so we don't restart the throttling thread unnecessarily
    if LAST_THROTTLE_BITS.swap(value.to_bits(), Ordering::Relaxed) == value.to_bits() {
        return;
    }
    let Some(params) = dictionary_value_create() else { return };
    params.set_double(Some(&CefString::from("rate")), value as f64);
    call(browser, "Emulation.setCPUThrottlingRate", Some(params));
}

pub fn clear_cache(browser: &Browser) {
    // keep dedupe cache in sync
    set_cpu_throttling(browser, 1.0);

    call(browser, "Network.clearBrowserCache", None);
    if let Some(params) = dictionary_value_create() {
        params.set_string(Some(&CefString::from("origin")), Some(&CefString::from("*")));
        params.set_string(Some(&CefString::from("storageTypes")), Some(&CefString::from("all")));
        call(browser, "Storage.clearDataForOrigin", Some(params));
    }
    browser.reload();
}

pub fn enable_network(browser: &Browser) {
    call(browser, "Network.enable", None);
}

// runs source on every new document of the browser (all frames), before the document's own scripts
pub fn add_document_script(browser: &Browser, source: &str) {
    let Some(params) = dictionary_value_create() else { return };
    params.set_string(Some(&CefString::from("source")), Some(&CefString::from(source)));
    params.set_bool(Some(&CefString::from("runImmediately")), 1);
    call(browser, "Page.addScriptToEvaluateOnNewDocument", Some(params));
}
