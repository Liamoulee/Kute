use crate::{constants, debug_print, modules, utils, utils::config};
use cef::{rc::*, *};
use std::{cell::RefCell, collections::HashMap};

// "message" listeners per frame id
thread_local! {
    static LISTENERS: RefCell<HashMap<String, Vec<V8Value>>> = RefCell::new(HashMap::new());
}

fn frame_key(frame: &Frame) -> String {
    utils::cef_to_string(&frame.identifier())
}

fn bundle_source() -> String {
    // bundle from the updater wins over the embedded one
    #[cfg(feature = "auto-update")]
    if let Ok(bundle) = std::fs::read_to_string(utils::exe_dir().join("resources").join("bundle.js"))
        && !bundle.is_empty()
    {
        return bundle;
    }

    #[cfg(feature = "editor-ignore")]
    {
        return include_str!("../target/bundle.js").to_string();
    }

    #[allow(unreachable_code)]
    String::new()
}

fn eval_value(context: &V8Context, code: &str, name: &str) -> Result<V8Value, String> {
    let mut retval = None;
    let mut exception = None;
    let script_url = CefString::from(format!("kute://{name}").as_str());
    if context.eval(Some(&CefString::from(code)), Some(&script_url), 0, Some(&mut retval), Some(&mut exception)) == 0 {
        let message = exception
            .map(|e| format!("{} (line {})", utils::cef_to_string(&e.message()), e.line_number()))
            .unwrap_or_default();
        debug_print!("renderer: {name} threw: {message}");
        return Err(message);
    }
    retval.ok_or_else(String::new)
}

fn eval(context: &V8Context, code: &str, name: &str) {
    if !code.is_empty() {
        eval_value(context, code, name).ok();
    }
}

// bundle grabs the userscript registry from here, removed before page scripts run
const REGISTRY_KEY: &str = "__kuteUserscripts";
const CUSTOM_CSS_KEY: &str = "__kuteCustomCss";

// runs before any page script. popups get theirs from handlers::on_after_created
fn inject_scripts(url: &str, context: &V8Context) {
    debug_print!("renderer: injecting into {url}");
    let registry = if config("userscripts", true) {
        v8_value_create_object(None, None)
    } else {
        None
    };
    let global = context.global();
    if let (Some(global), Some(registry)) = (&global, &registry) {
        global.set_value_bykey(
            Some(&CefString::from(REGISTRY_KEY)),
            Some(&mut registry.clone()),
            V8Propertyattribute::default(),
        );
    }
    // handed over here so it applies before the first paint, no round trip
    let custom_css = modules::custom_css::for_page();
    if let Some(global) = &global
        && !custom_css.is_empty()
        && let Some(mut css) = v8_value_create_string(Some(&CefString::from(custom_css.as_str())))
    {
        global.set_value_bykey(Some(&CefString::from(CUSTOM_CSS_KEY)), Some(&mut css), V8Propertyattribute::default());
    }
    eval(context, &bundle_source(), "bundle.js");
    if let Some(global) = &global
        && !custom_css.is_empty()
    {
        global.delete_value_bykey(Some(&CefString::from(CUSTOM_CSS_KEY)));
    }
    if let (Some(global), Some(registry)) = (global, registry) {
        global.delete_value_bykey(Some(&CefString::from(REGISTRY_KEY)));
        run_userscripts(context, registry);
    }
}

// compiled here because krunker traps eval and Function, the bundle must never compile anything
fn run_userscripts(context: &V8Context, registry: V8Value) {
    let scripts = modules::userscripts::load_group("game");
    if scripts.is_empty() {
        return;
    }
    let runner_source = format!("(function () {{\n{}\nreturn runUserscripts;\n}})()", modules::userscripts::RUNNER);
    let Ok(runner) = eval_value(context, &runner_source, "userscript-runner.js") else {
        return;
    };
    let described = serde_json::Value::Array(scripts.iter().map(|script| script.describe()).collect());
    let Some(list) = json_parse(context, &described.to_string()) else { return };

    for (index, script) in scripts.iter().enumerate() {
        let Some(item) = list.value_byindex(index as i32) else { continue };
        // wrapper on the first line keeps line numbers intact
        let wrapped = format!("(function (module, exports) {{{}\n}})", script.source);
        let (key, mut value) = match eval_value(context, &wrapped, &format!("scripts/{}", script.key)) {
            Ok(function) if function.is_function() != 0 => ("run", Some(function)),
            Ok(_) => continue,
            Err(message) => ("compileError", v8_value_create_string(Some(&CefString::from(message.as_str())))),
        };
        if let Some(value) = value.as_mut() {
            item.set_value_bykey(Some(&CefString::from(key)), Some(value), V8Propertyattribute::default());
        }
    }
    runner.execute_function(None, Some(&[Some(list), Some(registry)]));
}

wrap_v8_handler! {
    struct WebviewHandler;

    impl V8Handler {
        fn execute(
            &self,
            name: Option<&CefString>,
            _object: Option<&mut V8Value>,
            arguments: Option<&[Option<V8Value>]>,
            _retval: Option<&mut Option<V8Value>>,
            _exception: Option<&mut CefString>,
        ) -> ::std::os::raw::c_int {
            let name = utils::cef_str(name);
            let args = arguments.unwrap_or(&[]);
            let Some(context) = v8_context_get_current_context() else { return 0 };
            let Some(frame) = context.frame() else { return 0 };

            match name.as_str() {
                "postMessage" => {
                    // strings only, like WebView2
                    let Some(Some(value)) = args.first() else { return 1 };
                    if value.is_string() == 0 {
                        return 1;
                    }
                    let text = utils::cef_to_string(&value.string_value());
                    let Some(mut message) = process_message_create(Some(&CefString::from(constants::MSG_FROM_PAGE))) else { return 1 };
                    if let Some(list) = message.argument_list() {
                        list.set_string(0, Some(&CefString::from(text.as_str())));
                    }
                    frame.send_process_message(ProcessId::BROWSER, Some(&mut message));
                }
                "addEventListener" => {
                    let (Some(Some(kind)), Some(Some(listener))) = (args.first(), args.get(1)) else { return 1 };
                    if kind.is_string() == 0 || utils::cef_to_string(&kind.string_value()) != "message" || listener.is_function() == 0 {
                        return 1;
                    }
                    let key = frame_key(&frame);
                    LISTENERS.with_borrow_mut(|map| map.entry(key).or_default().push(listener.clone()));
                }
                "removeEventListener" => {
                    let (Some(Some(kind)), Some(Some(listener))) = (args.first(), args.get(1)) else { return 1 };
                    if kind.is_string() == 0 || utils::cef_to_string(&kind.string_value()) != "message" {
                        return 1;
                    }
                    let key = frame_key(&frame);
                    LISTENERS.with_borrow_mut(|map| {
                        if let Some(listeners) = map.get_mut(&key) {
                            listeners.retain(|existing| {
                                let mut candidate = listener.clone();
                                existing.is_same(Some(&mut candidate)) == 0
                            });
                        }
                    });
                }
                _ => return 0,
            }
            1
        }
    }
}

fn set_function(object: &V8Value, name: &str, handler: &mut V8Handler) {
    if let Some(mut function) = v8_value_create_function(Some(&CefString::from(name)), Some(handler)) {
        object.set_value_bykey(Some(&CefString::from(name)), Some(&mut function), V8Propertyattribute::default());
    }
}

fn install_bridge(context: &V8Context) {
    let Some(global) = context.global() else { return };
    let chrome_key = CefString::from("chrome");
    let chrome = match global.value_bykey(Some(&chrome_key)) {
        Some(existing) if existing.is_object() != 0 => existing,
        _ => {
            let Some(mut created) = v8_value_create_object(None, None) else { return };
            global.set_value_bykey(Some(&chrome_key), Some(&mut created), V8Propertyattribute::default());
            created
        }
    };
    let Some(mut webview) = v8_value_create_object(None, None) else { return };
    let mut handler = WebviewHandler::new();
    for name in ["postMessage", "addEventListener", "removeEventListener"] {
        set_function(&webview, name, &mut handler);
    }
    chrome.set_value_bykey(Some(&CefString::from("webview")), Some(&mut webview), V8Propertyattribute::default());
}

fn json_parse(context: &V8Context, json: &str) -> Option<V8Value> {
    let global = context.global()?;
    let json_object = global.value_bykey(Some(&CefString::from("JSON")))?;
    let parse = json_object.value_bykey(Some(&CefString::from("parse")))?;
    let mut this = json_object.clone();
    let text = v8_value_create_string(Some(&CefString::from(json)))?;
    parse.execute_function(Some(&mut this), Some(&[Some(text)]))
}

fn dispatch(frame: &Frame, is_json: bool, payload: &str) {
    let key = frame_key(frame);
    let listeners: Vec<V8Value> = LISTENERS.with_borrow(|map| map.get(&key).cloned().unwrap_or_default());
    if listeners.is_empty() {
        return;
    }
    let Some(context) = frame.v8_context() else { return };
    if context.enter() == 0 {
        return;
    }

    let data = if is_json {
        json_parse(&context, payload)
    } else {
        v8_value_create_string(Some(&CefString::from(payload)))
    };
    if let Some(mut data) = data
        && let Some(event) = v8_value_create_object(None, None)
    {
        event.set_value_bykey(Some(&CefString::from("data")), Some(&mut data), V8Propertyattribute::default());
        for listener in listeners {
            listener.execute_function(None, Some(&[Some(event.clone())]));
        }
    } else {
        debug_print!("renderer: cannot build message event for {payload}");
    }

    context.exit();
}

wrap_render_process_handler! {
    pub struct KuteRenderProcessHandler;

    impl RenderProcessHandler {
        fn on_context_created(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, context: Option<&mut V8Context>) {
            let (Some(browser), Some(frame), Some(context)) = (browser, frame, context) else { return };
            if context.enter() == 0 {
                return;
            }
            install_bridge(context);
            if frame.is_main() != 0 && browser.is_popup() == 0 {
                inject_scripts(&utils::cef_to_string(&frame.url()), context);
            }
            context.exit();
        }

        fn on_context_released(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _context: Option<&mut V8Context>) {
            let Some(frame) = frame else { return };
            let key = frame_key(frame);
            LISTENERS.with_borrow_mut(|map| map.remove(&key));
        }

        fn on_process_message_received(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _source_process: ProcessId,
            message: Option<&mut ProcessMessage>,
        ) -> ::std::os::raw::c_int {
            let (Some(frame), Some(message)) = (frame, message) else { return 0 };
            if utils::cef_to_string(&message.name()) != constants::MSG_TO_PAGE {
                return 0;
            }
            let Some(args) = message.argument_list() else { return 1 };
            let is_json = args.bool(0) != 0;
            let payload = utils::cef_to_string(&args.string(1));
            dispatch(frame, is_json, &payload);
            1
        }
    }
}
