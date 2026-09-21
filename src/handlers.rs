use crate::{app, bridge, constants, debug_print, modules, utils, utils::config, window};
use cef::{rc::*, *};
use std::sync::Mutex;

// args handed over by a second instance while the main window was being recreated
static PENDING_ARGS: Mutex<Option<String>> = Mutex::new(None);

pub fn set_pending_args(args: String) {
    *PENDING_ARGS.lock().unwrap() = Some(args);
}

pub fn parse_web_message_value(value: &str) -> serde_json::Value {
    if let Ok(bool_val) = value.parse::<bool>() {
        serde_json::Value::Bool(bool_val)
    } else if let Ok(int_val) = value.parse::<i64>() {
        serde_json::Value::Number(serde_json::Number::from(int_val))
    } else if let Ok(float_val) = value.parse::<f64>() {
        serde_json::Value::Number(serde_json::Number::from_f64((float_val * 100.0).round() / 100.0).unwrap())
    } else {
        serde_json::Value::String(value.to_string())
    }
}

fn request_url(request: Option<&mut Request>) -> Option<String> {
    let request = request?;
    Some(utils::cef_to_string(&request.url()))
}

// the page asked about a lobby, tell the bundle (runs on the UI thread, the load hook is on IO)
wrap_task! {
    struct GameUpdatedTask {
        browser_id: i32,
    }

    impl Task {
        fn execute(&self) {
            if let Some(browser) = window::browser_by_id(self.browser_id) {
                bridge::post_string(&browser, "game-updated");
            }
        }
    }
}

// mirrors the WebResourceRequested handler: blocklist, game-updated signal and the swapper
wrap_resource_request_handler! {
    struct KuteResourceRequestHandler;

    impl ResourceRequestHandler {
        fn on_before_resource_load(
            &self,
            browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            request: Option<&mut Request>,
            _callback: Option<&mut Callback>,
        ) -> ReturnValue {
            let Some(url) = request_url(request) else { return ReturnValue::CONTINUE };

            if url.contains("krunker.io") && (url.contains("game-info") || url.contains("lobby-ranked")) {
                if let Some(browser) = browser {
                    let mut task = GameUpdatedTask::new(browser.identifier());
                    post_task(ThreadId::UI, Some(&mut task));
                }
                return ReturnValue::CONTINUE;
            }

            if modules::blocklist::is_blocked(&url) {
                debug_print!("handlers: blocked {url}");
                return ReturnValue::CANCEL;
            }
            ReturnValue::CONTINUE
        }

        fn resource_handler(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            request: Option<&mut Request>,
        ) -> Option<ResourceHandler> {
            let url = request_url(request)?;
            if modules::bench::active() && url.contains(modules::bench::BENCH_PATH) {
                return modules::resource::serve("text/html", modules::bench::STUB_PAGE.as_bytes().to_vec());
            }
            let bytes = modules::swapper::swap_for(&url)?;
            debug_print!("handlers: swapping {url}");

            let filename = url.split("krunker.io/").nth(1).and_then(|s| s.split('?').next()).unwrap_or("");
            modules::resource::serve(modules::swapper::mime_for(filename), bytes.clone())
        }
    }
}

wrap_request_handler! {
    struct KuteRequestHandler;

    impl RequestHandler {
        fn resource_request_handler(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _request: Option<&mut Request>,
            _is_navigation: ::std::os::raw::c_int,
            _is_download: ::std::os::raw::c_int,
            _request_initiator: Option<&CefString>,
            _disable_default_handling: Option<&mut ::std::os::raw::c_int>,
        ) -> Option<ResourceRequestHandler> {
            Some(KuteResourceRequestHandler::new())
        }
    }
}

// requests without a browser (the service worker script, fetches made by it) come through here
wrap_request_context_handler! {
    pub struct KuteRequestContextHandler;

    impl RequestContextHandler {
        fn resource_request_handler(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _request: Option<&mut Request>,
            _is_navigation: ::std::os::raw::c_int,
            _is_download: ::std::os::raw::c_int,
            _request_initiator: Option<&CefString>,
            _disable_default_handling: Option<&mut ::std::os::raw::c_int>,
        ) -> Option<ResourceRequestHandler> {
            Some(KuteResourceRequestHandler::new())
        }
    }
}

// CEF reports windows virtual key codes
const VK_F4: i32 = 0x73;
const VK_F5: i32 = 0x74;
const VK_F6: i32 = 0x75;
const VK_F11: i32 = 0x7A;
const VK_F12: i32 = 0x7B;

// mirrors AcceleratorKeyPressed: the client reacts, the page still receives the key
wrap_keyboard_handler! {
    struct KuteKeyboardHandler;

    impl KeyboardHandler {
        fn on_pre_key_event(
            &self,
            browser: Option<&mut Browser>,
            event: Option<&KeyEvent>,
            _os_event: Option<&mut sys::MSG>,
            _is_keyboard_shortcut: Option<&mut ::std::os::raw::c_int>,
        ) -> ::std::os::raw::c_int {
            let (Some(browser), Some(event)) = (browser, event) else { return 0 };
            if event.type_ != KeyEventType::RAWKEYDOWN {
                return 0;
            }
            if matches!(event.windows_key_code, VK_F4 | VK_F5 | VK_F6 | VK_F11 | VK_F12) {
                window::handle_accelerator_key(browser, event.windows_key_code as u16);
            }
            0
        }
    }
}

// mirrors SetAreBrowserAcceleratorKeysEnabled(false): no chrome commands (reload, zoom, find, ...)
wrap_command_handler! {
    struct KuteCommandHandler;

    impl CommandHandler {
        fn on_chrome_command(
            &self,
            _browser: Option<&mut Browser>,
            _command_id: ::std::os::raw::c_int,
            _disposition: WindowOpenDisposition,
        ) -> ::std::os::raw::c_int {
            1
        }
    }
}

// mirrors PermissionRequested -> ALLOW (pointer lock, media, ...)
wrap_permission_handler! {
    struct KutePermissionHandler;

    impl PermissionHandler {
        fn on_request_media_access_permission(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _requesting_origin: Option<&CefString>,
            requested_permissions: u32,
            callback: Option<&mut MediaAccessCallback>,
        ) -> ::std::os::raw::c_int {
            let Some(callback) = callback else { return 0 };
            callback.cont(requested_permissions);
            1
        }

        fn on_show_permission_prompt(
            &self,
            _browser: Option<&mut Browser>,
            _prompt_id: u64,
            _requesting_origin: Option<&CefString>,
            _requested_permissions: u32,
            callback: Option<&mut PermissionPromptCallback>,
        ) -> ::std::os::raw::c_int {
            let Some(callback) = callback else { return 0 };
            callback.cont(PermissionRequestResult::ACCEPT);
            1
        }
    }
}

// mirrors SetAreDefaultContextMenusEnabled(false)
wrap_context_menu_handler! {
    struct KuteContextMenuHandler;

    impl ContextMenuHandler {
        fn on_before_context_menu(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _params: Option<&mut ContextMenuParams>,
            model: Option<&mut MenuModel>,
        ) {
            if let Some(model) = model {
                model.clear();
            }
        }
    }
}

// downloads (settings export) go straight to the Downloads folder, the bundle shows the notification
wrap_download_handler! {
    struct KuteDownloadHandler;

    impl DownloadHandler {
        fn can_download(
            &self,
            _browser: Option<&mut Browser>,
            _url: Option<&CefString>,
            _request_method: Option<&CefString>,
        ) -> ::std::os::raw::c_int {
            1
        }

        fn on_before_download(
            &self,
            _browser: Option<&mut Browser>,
            _download_item: Option<&mut DownloadItem>,
            suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> ::std::os::raw::c_int {
            let Some(callback) = callback else { return 0 };
            // the path has to be ours: handed an empty one, CEF writes the file into the temp directory, which
            // is where every exported settings file went while the game said "Settings exported to Downloads!"
            let suggested = suggested_name.map(|name| name.to_string()).unwrap_or_default();
            let target = crate::utils::download_target(&suggested);
            debug_print!("download: {} -> {}", suggested, target.display());
            callback.cont(Some(&CefString::from(target.to_string_lossy().as_ref())), 0);
            1
        }
    }
}

// mirrors SetAllowExternalDrop(false)
wrap_drag_handler! {
    struct KuteDragHandler;

    impl DragHandler {
        fn on_drag_enter(
            &self,
            _browser: Option<&mut Browser>,
            _drag_data: Option<&mut DragData>,
            _mask: DragOperationsMask,
        ) -> ::std::os::raw::c_int {
            1
        }
    }
}

wrap_display_handler! {
    struct KuteDisplayHandler;

    impl DisplayHandler {
        fn on_console_message(
            &self,
            _browser: Option<&mut Browser>,
            _level: LogSeverity,
            _message: Option<&CefString>,
            _source: Option<&CefString>,
            _line: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int {
            debug_print!("console: {} ({}:{_line})", utils::cef_str(_message), utils::cef_str(_source));
            0
        }
    }
}

wrap_life_span_handler! {
    struct KuteLifeSpanHandler;

    impl LifeSpanHandler {
        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: ::std::os::raw::c_int,
            _target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition,
            _user_gesture: ::std::os::raw::c_int,
            popup_features: Option<&PopupFeatures>,
            window_info: Option<&mut WindowInfo>,
            client: Option<&mut Option<Client>>,
            settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut ::std::os::raw::c_int>,
        ) -> ::std::os::raw::c_int {
            debug_print!("handlers: popup requested for {}", utils::cef_str(_target_url));
            window::create_popup_window(popup_features, window_info, client, settings);
            0
        }

        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser else { return };
            window::attach_browser(browser);
            if browser.is_popup() != 0 {
                // a same origin popup keeps the initial window and swaps the document, so the social
                // userscripts are registered per document (like WebView2 did) instead of per V8 context
                if config("userscripts", true) {
                    let scripts = modules::userscripts::load(true);
                    if !scripts.is_empty() {
                        let source = format!(
                            "if (window === window.top && location.href.includes(\"krunker.io/social.html\")) {{\n{}\n}}",
                            scripts.join("\n")
                        );
                        modules::devtools::add_document_script(browser, &source);
                    }
                }
                return;
            }
            if let Some(args) = PENDING_ARGS.lock().unwrap().take() {
                let string = serde_json::to_string(&args).unwrap_or_else(|_| String::new());
                bridge::post_json(browser, &format!("{{\"args\":{}}}", string));
            }
        }

        fn do_close(&self, browser: Option<&mut Browser>) -> ::std::os::raw::c_int {
            if let Some(browser) = browser {
                window::mark_closing(browser);
            }
            0
        }

        fn on_before_close(&self, browser: Option<&mut Browser>) {
            if let Some(browser) = browser {
                window::detach_browser(browser);
            }
        }
    }
}

wrap_client! {
    pub struct KuteClient;

    impl Client {
        fn command_handler(&self) -> Option<CommandHandler> {
            Some(KuteCommandHandler::new())
        }

        fn context_menu_handler(&self) -> Option<ContextMenuHandler> {
            Some(KuteContextMenuHandler::new())
        }

        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(KuteDisplayHandler::new())
        }

        fn download_handler(&self) -> Option<DownloadHandler> {
            Some(KuteDownloadHandler::new())
        }

        fn drag_handler(&self) -> Option<DragHandler> {
            Some(KuteDragHandler::new())
        }

        fn permission_handler(&self) -> Option<PermissionHandler> {
            Some(KutePermissionHandler::new())
        }

        fn keyboard_handler(&self) -> Option<KeyboardHandler> {
            Some(KuteKeyboardHandler::new())
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(KuteLifeSpanHandler::new())
        }

        fn request_handler(&self) -> Option<RequestHandler> {
            Some(KuteRequestHandler::new())
        }

        fn on_process_message_received(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _source_process: ProcessId,
            message: Option<&mut ProcessMessage>,
        ) -> ::std::os::raw::c_int {
            let (Some(browser), Some(frame), Some(message)) = (browser, frame, message) else { return 0 };
            if utils::cef_to_string(&message.name()) != constants::MSG_FROM_PAGE {
                return 0;
            }
            // WebView2 only delivered messages of the main frame of the main webview
            if frame.is_main() == 0 || browser.is_popup() != 0 {
                return 1;
            }
            let Some(args) = message.argument_list() else { return 1 };
            let text = utils::cef_to_string(&args.string(0));
            handle_web_message(browser, frame, &text);
            1
        }
    }
}

// "list", "add <json>", "remove <json>", "login <json>", "migrate <json array>". every command answers with
// {accounts: [{username, color}]} so the page always shows what the store holds
fn handle_accounts_message(browser: &Browser, message: &str) {
    let (command, payload) = message.split_once(' ').unwrap_or((message, ""));
    if payload.len() > 64 * 1024 {
        return;
    }
    match command {
        "list" => {}
        "add" => {
            if let Ok(credentials) = serde_json::from_str::<modules::accounts::Credentials>(payload) {
                modules::accounts::add(&credentials);
            }
        }
        "migrate" => {
            if let Ok(list) = serde_json::from_str::<Vec<modules::accounts::Credentials>>(payload) {
                for credentials in &list {
                    modules::accounts::add(credentials);
                }
            }
        }
        "remove" | "login" => {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
                return;
            };
            let Some(username) = value["username"].as_str() else { return };
            if command == "remove" {
                modules::accounts::remove(username);
            } else {
                modules::accounts::login(browser, username);
            }
        }
        _ => return,
    }
    bridge::post_json(browser, &serde_json::json!({ "accounts": modules::accounts::list() }).to_string());
}

pub fn open_documents_subpath(target: &str) {
    let path_to_open = match target {
        "blocklist" => utils::settings_dir().join("user_blocklist.json"),
        "swapper" => utils::settings_dir().join("swapper"),
        "userscripts" => utils::settings_dir().join("scripts"),
        _ => return,
    };
    std::process::Command::new("explorer.exe").arg(path_to_open).spawn().ok();
}

// links of the about popup. they open in the user's browser, where they are signed in to github
pub fn open_in_default_browser(url: &str) {
    // "https://kute.lol" without the slash is the same place as with it
    let allowed = constants::OPEN_URL_ALLOWED
        .iter()
        .any(|prefix| url.starts_with(prefix) || url == prefix.trim_end_matches('/'));
    if !allowed || url.chars().any(|c| c.is_whitespace() || c == '"') {
        return;
    }
    use windows::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let url = windows::core::HSTRING::from(url);
    unsafe {
        ShellExecuteW(None, windows::core::w!("open"), &url, None, None, SW_SHOWNORMAL);
    }
}

pub fn handle_web_message(browser: &Browser, frame: &Frame, message_string: &str) {
    debug_print!("web message: {message_string}");
    // the payload is JSON, so it must not go through the ", " split
    if let Some(rest) = message_string.strip_prefix("telemetry ") {
        // "telemetry <kind> <json>". JSON, so it must not go through the ", " split. capped like the server caps it
        if let Some((kind, report)) = rest.split_once(' ')
            && report.len() <= 64 * 1024
        {
            modules::lifecycle::send_telemetry(kind, report.to_string());
        }
        return;
    }
    // a setting whose value is an object (the matchmaker filters): "set-config-json <id> <json>"
    if let Some(rest) = message_string.strip_prefix("set-config-json ") {
        if let Some((setting, value)) = rest.split_once(' ')
            && value.len() <= 16 * 1024
            && let Ok(value) = serde_json::from_str::<serde_json::Value>(value)
        {
            crate::CONFIG.lock().unwrap().set(setting, value);
            crate::config::save_soon();
        }
        return;
    }
    // the account manager: JSON payloads, replies with the list (names and colors, never a password)
    if let Some(rest) = message_string.strip_prefix("accounts-") {
        handle_accounts_message(browser, rest);
        return;
    }
    if message_string == "bench-sample-start" {
        // the settle phase is over: throw away what the hook collected so far (without the hook nobody would answer)
        if modules::bench::config().is_some_and(|bench| bench.hook) {
            app::take_present_intervals();
        }
        return;
    }
    if let Some(result) = message_string.strip_prefix("bench-finish ") {
        modules::bench::finish(result);
        return;
    }
    if let Some(configs) = message_string.strip_prefix("run-bench-matrix ") {
        // only what a bench configuration is made of, the strings end up on a command line
        let configs: Vec<String> = serde_json::from_str(configs).unwrap_or_default();
        let harmless = |config: &String| config.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '=' | ',' | '.'));
        if !modules::bench::active() && configs.len() <= 8 && configs.iter().all(harmless) {
            modules::bench::run_matrix(browser, configs);
        }
        return;
    }
    let parts: Vec<&str> = message_string.split(", ").map(|s| s.trim()).collect();

    match parts.as_slice() {
        ["set-config", setting, value] => {
            crate::CONFIG.lock().unwrap().set(setting, parse_web_message_value(value));
            crate::config::save_soon();

            // the one FPS limit: the present hook paces the whole game loop (see gameFpsLimit.js for the fallback)
            if *setting == "gameFpsLimit"
                && let Ok(fps_limit) = value.parse::<u64>()
            {
                app::set_target_fps(fps_limit);
            }
        }
        ["obs-plugin", value] => {
            let install = value.parse::<bool>().unwrap_or(false);
            modules::obs::set_plugin_installed(frame, install);
            if !install {
                crate::CONFIG.lock().unwrap().set("obsCapturePlugin", false);
                crate::config::save_soon();
            }
        }
        ["get-info"] => {
            bridge::send_info(frame);
        }
        // the developer badge: the page hands over the server's nonce and what it is about to announce, and
        // gets the proof back. the token stays in this process (modules/dev.rs)
        ["dev-proof", nonce, game, hash] => {
            let sane = nonce.len() <= 64 && game.len() <= 32 && hash.len() == 32;
            let proof = if sane { modules::dev::proof(nonce, game, hash) } else { None };
            let reply = match proof {
                Some((user, proof)) => serde_json::json!({ "devProof": { "nonce": nonce, "user": user, "proof": proof } }),
                None => serde_json::json!({ "devProof": { "nonce": nonce } }),
            };
            bridge::post_json(browser, &reply.to_string());
        }
        ["drag", value] => {
            // "drag, true" means the menu is open and the pointer is free
            let value = value.parse::<bool>().unwrap_or(false);
            modules::input::set_pointer_locked(!value);
        }
        ["throttle", status] => {
            // "off" is the auto-detect run measuring the unthrottled page
            let rate = match *status {
                "off" => 1.0,
                "game" => config("throttle", 1.0),
                _ => config("inMenuThrottle", 1.0),
            };
            modules::devtools::set_cpu_throttling(browser, rate);
        }
        ["get-specs"] => {
            let hwnd = window::root_hwnd(browser).unwrap_or_default();
            bridge::post_json(browser, &serde_json::json!({ "specs": modules::specs::collect(hwnd) }).to_string());
        }
        // frames per second at the swap chain, 0 without the hook
        ["get-present"] => {
            let fps = app::render_stats().map(|(fps, _)| fps).unwrap_or(0);
            bridge::post_json(browser, &format!("{{\"presentFps\":{fps}}}"));
        }
        // the distribution of the hook's present intervals since the last call (a call also starts a new window)
        ["get-present-intervals"] => {
            let intervals = if config("hardFlip", true) { app::take_present_intervals() } else { None };
            let reply = match intervals {
                Some((p50, p99, max, arrive_p99, samples)) => serde_json::json!({ "presentIntervals": {
                    "p50": p50 as f64 / 1e6, "p99": p99 as f64 / 1e6, "max": max as f64 / 1e6, "arriveP99": arrive_p99 as f64 / 1e6, "samples": samples,
                } }),
                None => serde_json::json!({ "presentIntervals": false }),
            };
            bridge::post_json(browser, &reply.to_string());
        }
        ["click", x, y] => {
            if let (Ok(x), Ok(y)) = (x.parse(), y.parse()) {
                modules::devtools::click(browser, x, y);
            }
        }
        ["close"] => {
            window::close_all();
        }
        ["restart"] => {
            modules::lifecycle::restart();
        }
        ["bring-to-front"] => {
            window::bring_to_front(browser);
        }
        ["clear-cache"] => {
            modules::devtools::clear_cache(browser);
        }
        ["open", target] => {
            open_documents_subpath(target);
        }
        ["open-url", url] => {
            open_in_default_browser(url);
        }
        ["rpc-update", part1, part2] => {
            let state = format!("{} on {}", part1, part2);
            if let Some(client) = &mut *app::DISCORD.lock().unwrap() {
                let activity = discord_rich_presence::activity::Activity::new()
                    .details("Krunker")
                    .state(&state)
                    .assets(discord_rich_presence::activity::Assets::new());
                if let Err(e) = discord_rich_presence::DiscordIpc::set_activity(client, activity) {
                    eprintln!("Failed to set rpc activity: {}", e);
                }
            }
        }
        ["toggle-rboost", value] => {
            let value = value.parse::<bool>().unwrap_or(false);
            modules::input::set_rampboost(value);
        }
        ["ping"] => {
            modules::ping::ping(browser.identifier());
        }
        ["ping-regions"] => {
            modules::ping::ping_regions(browser.identifier());
        }
        _ => {}
    }
}
