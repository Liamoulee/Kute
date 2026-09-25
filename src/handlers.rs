use crate::{app, bridge, constants, debug_print, modules, utils, utils::config, window};
use cef::{rc::*, *};
use std::sync::{LazyLock, Mutex, mpsc};

// args from a second instance while the main window gets recreated
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

// load hook runs on IO, this hops to UI
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

// loads a mod page in the main window after on_before_popup returned
wrap_task! {
    struct LoadInMainTask {
        url: String,
    }

    impl Task {
        fn execute(&self) {
            window::load_in_main(&self.url);
        }
    }
}

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

            // kute icons answer the player's kute.lol/kr urls locally, that is no contact with the server
            if modules::blocklist::is_blocked(&url) && modules::icons::bytes_for(&url).is_none() {
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
            // player's swapper beats our own swaps
            if let Some(bytes) = modules::swapper::swap_for(&url) {
                debug_print!("handlers: swapping {url}");
                let filename = utils::krunker_path(&url).unwrap_or("");
                return modules::resource::serve(modules::swapper::mime_for(filename), bytes.to_vec());
            }
            let bytes = modules::icons::bytes_for(&url)?;
            debug_print!("handlers: kute icon for {url}");
            modules::resource::serve("image/png", bytes.to_vec())
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

// requests without a browser (service worker) only pass through here
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

const VK_F4: i32 = 0x73;
const VK_F5: i32 = 0x74;
const VK_F6: i32 = 0x75;
const VK_F11: i32 = 0x7A;
const VK_F12: i32 = 0x7B;

// page still gets the key
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
            // an empty path makes cef write into temp
            let suggested = suggested_name.map(|name| name.to_string()).unwrap_or_default();
            let target = crate::utils::download_target(&suggested);
            debug_print!("download: {} -> {}", suggested, target.display());
            callback.cont(Some(&CefString::from(target.to_string_lossy().as_ref())), 0);
            1
        }
    }
}

// only called for alloy style browsers, ours are chrome style so drops still reach the managers
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
            let url = utils::cef_str(_target_url);
            debug_print!("handlers: popup requested for {url}");
            // mod "Use" button, a second game window would kick the first one (one session per account)
            if window::is_mod_page(&url) && window::has_main_browser() {
                let mut task = LoadInMainTask::new(url);
                post_task(ThreadId::UI, Some(&mut task));
                return 1;
            }
            window::create_popup_window(popup_features, window_info, client, settings);
            0
        }

        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser else { return };
            window::attach_browser(browser);
            if browser.is_popup() != 0 {
                // same origin popups keep the V8 context and swap the document, so register per document
                if config("userscripts", true) {
                    // one per script so a syntax error doesn't kill the rest
                    for script in modules::userscripts::social_document_scripts() {
                        let source =
                            format!("if (window === window.top && location.href.includes(\"krunker.io/social.html\")) {{\n{script}\n}}");
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
            // main frame of the main browser only, like WebView2
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

// manager commands write files, a non krunker page could plant a userscript
fn is_krunker_frame(frame: &Frame) -> bool {
    let url = utils::cef_to_string(&frame.url());
    url.starts_with("https://") && utils::krunker_path(&url).is_some()
}

fn payload_str<'a>(payload: &'a serde_json::Value, key: &str) -> &'a str {
    payload[key].as_str().unwrap_or_default()
}

// one worker thread for manager file IO: keeps disk off the UI thread and swapper reloads in order
static MANAGER_QUEUE: LazyLock<Option<mpsc::Sender<(i32, String)>>> = LazyLock::new(|| {
    let (sender, receiver) = mpsc::channel::<(i32, String)>();
    std::thread::Builder::new()
        .name("kute-managers".into())
        .spawn(move || {
            for (browser_id, message) in receiver {
                let reply = match message.split_once('-') {
                    Some(("scripts", rest)) => handle_scripts_message(rest),
                    Some(("swapper", rest)) => handle_swapper_message(rest),
                    Some(("css", rest)) => handle_css_message(rest),
                    _ => None,
                };
                if let Some(reply) = reply {
                    bridge::post_json_later(browser_id, reply);
                }
            }
        })
        .ok()
        .map(|_| sender)
});

fn queue_manager_message(browser: &Browser, message: &str) {
    if let Some(queue) = MANAGER_QUEUE.as_ref() {
        queue.send((browser.identifier(), message.to_string())).ok();
    }
}

fn manager_reply(key: &str, list: serde_json::Value, problems: &[String]) -> Option<String> {
    let mut reply = serde_json::json!({ key: list });
    if !problems.is_empty() {
        reply["managerError"] = serde_json::json!(problems.join("\n"));
    }
    Some(reply.to_string())
}

fn handle_scripts_message(message: &str) -> Option<String> {
    use modules::userscripts;
    let (command, payload) = message.split_once(' ').unwrap_or((message, "{}"));
    let payload = serde_json::from_str::<serde_json::Value>(payload).ok()?;
    let key = payload_str(&payload, "key");
    let mut problems: Vec<String> = Vec::new();
    match command {
        "list" => {}
        "read" => {
            return Some(serde_json::json!({ "userscriptSource": { "key": key, "content": userscripts::read(key) } }).to_string());
        }
        "write" => {
            let result = userscripts::write(payload_str(&payload, "group"), payload_str(&payload, "file"), payload_str(&payload, "content"));
            problems.extend(result.err());
            // bulk import asks for the list once at the end
            if payload["noList"].as_bool() == Some(true) {
                return (!problems.is_empty()).then(|| serde_json::json!({ "managerError": problems.join("\n") }).to_string());
            }
        }
        "toggle" => userscripts::set_enabled(key, payload["enabled"].as_bool().unwrap_or(true)),
        "prefs" => {
            userscripts::set_prefs(key, payload["prefs"].clone());
            return None;
        }
        "delete" => problems.extend(userscripts::delete(key).err()),
        "move" => problems.extend(userscripts::move_to(key, payload_str(&payload, "group")).err()),
        "reveal" => {
            userscripts::reveal(if key.is_empty() { None } else { Some(key) });
            return None;
        }
        _ => return None,
    }
    manager_reply("userscripts", userscripts::list(), &problems)
}

fn handle_swapper_message(message: &str) -> Option<String> {
    use modules::swapper;
    let (command, payload) = message.split_once(' ').unwrap_or((message, "{}"));
    let payload = serde_json::from_str::<serde_json::Value>(payload).ok()?;
    let path = payload_str(&payload, "path");
    let mut problems: Vec<String> = Vec::new();
    match command {
        // picks up files added through explorer
        "list" => swapper::reload(),
        "mkdir" => problems.extend(swapper::make_dir(path).err()),
        "delete" => problems.extend(swapper::delete(path).err()),
        "move" => problems.extend(swapper::move_to(payload_str(&payload, "from"), payload_str(&payload, "to")).err()),
        // one base64 file at a time, page waits for the ack before sending the next
        "upload" => {
            let result = swapper::upload(path, payload_str(&payload, "data"));
            let error = result.err().map(|e| format!("{path}: {e}"));
            return Some(serde_json::json!({ "swapperUploaded": { "path": path, "error": error } }).to_string());
        }
        "reveal" => {
            swapper::reveal(path);
            return None;
        }
        "read" => {
            return Some(serde_json::json!({ "swapperSource": { "path": path, "content": swapper::read_text(path) } }).to_string());
        }
        "write" => {
            let result = swapper::write_text(path, payload_str(&payload, "content"));
            let error = result.err().map(|e| format!("{path}: {e}"));
            return Some(serde_json::json!({ "swapper": swapper::list(), "swapperWritten": { "path": path, "error": error } }).to_string());
        }
        _ => return None,
    }
    manager_reply("swapper", swapper::list(), &problems)
}

fn handle_css_message(message: &str) -> Option<String> {
    use modules::custom_css;
    let (command, payload) = message.split_once(' ').unwrap_or((message, "{}"));
    let payload = serde_json::from_str::<serde_json::Value>(payload).ok()?;
    match command {
        "read" => Some(serde_json::json!({ "customCss": { "content": custom_css::read() } }).to_string()),
        "write" => {
            let error = custom_css::write(payload_str(&payload, "content")).err();
            Some(serde_json::json!({ "customCssSaved": { "error": error } }).to_string())
        }
        "reveal" => {
            custom_css::reveal();
            None
        }
        _ => None,
    }
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

pub fn open_in_default_browser(url: &str) {
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
    // swapper uploads are whole files, only log the start
    if message_string.len() > 300 {
        let cut = (0..=300).rev().find(|&index| message_string.is_char_boundary(index)).unwrap_or(0);
        debug_print!("web message: {}... ({} bytes)", &message_string[..cut], message_string.len());
    } else {
        debug_print!("web message: {message_string}");
    }
    if let Some(rest) = message_string.strip_prefix("icon-urls ") {
        if rest.len() <= 16 * 1024
            && let Ok(value) = serde_json::from_str::<serde_json::Value>(rest)
        {
            modules::icons::set_player_urls(&value);
        }
        return;
    }
    // set-config can't carry objects (matchmaker filter)
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
    if let Some(rest) = message_string.strip_prefix("scripts-") {
        if is_krunker_frame(frame) && rest.len() <= 5 * 1024 * 1024 {
            queue_manager_message(browser, message_string);
        }
        return;
    }
    if let Some(rest) = message_string.strip_prefix("swapper-") {
        // uploads carry a whole base64 file
        if is_krunker_frame(frame) && rest.len() <= 48 * 1024 * 1024 {
            queue_manager_message(browser, message_string);
        }
        return;
    }
    if let Some(rest) = message_string.strip_prefix("css-") {
        if is_krunker_frame(frame) && rest.len() <= 8 * 1024 * 1024 {
            queue_manager_message(browser, message_string);
        }
        return;
    }
    // replies never contain a password
    if let Some(rest) = message_string.strip_prefix("accounts-") {
        handle_accounts_message(browser, rest);
        return;
    }
    if message_string == "spotify-start" {
        modules::spotify::start(browser.identifier());
        return;
    }
    if message_string == "spotify-stop" {
        modules::spotify::stop();
        return;
    }
    if message_string == "bench-sample-start" {
        // settle phase over, drop what the hook collected so far
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
        // ends up on a command line, whitelist the chars
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

            if *setting == "disableOnlineFeatures" {
                modules::blocklist::set_online_off(*value == "true");
            }
            if *setting == "disableCats" {
                modules::blocklist::set_cats_off(*value == "true");
            }
            // present hook paces the game loop, gameFpsLimit.js has the fallback
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
        // dev badge proof, the token never leaves this process
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
            // true = menu open, pointer free
            let value = value.parse::<bool>().unwrap_or(false);
            modules::input::set_pointer_locked(!value);
        }
        ["throttle", status] => {
            // "off" is used by auto-detect
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
        // swap chain fps, 0 without the hook
        ["get-present"] => {
            let fps = app::render_stats().map(|(fps, _)| fps).unwrap_or(0);
            bridge::post_json(browser, &format!("{{\"presentFps\":{fps}}}"));
        }
        ["get-present-intervals"] => {
            // blocks up to 150 ms, off the UI thread
            let hook = config("hardFlip", true);
            let browser_id = browser.identifier();
            std::thread::spawn(move || {
                let intervals = if hook { app::take_present_intervals() } else { None };
                let reply = match intervals {
                    Some((p50, p99, max, arrive_p99, samples)) => serde_json::json!({ "presentIntervals": {
                    "p50": p50 as f64 / 1e6, "p99": p99 as f64 / 1e6, "max": max as f64 / 1e6, "arriveP99": arrive_p99 as f64 / 1e6, "samples": samples,
                } }),
                    None => serde_json::json!({ "presentIntervals": false }),
                };
                bridge::post_json_later(browser_id, reply.to_string());
            });
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
        // shows changed icons. never use clear-cache for that, it wipes all krunker settings
        ["hard-reload"] => {
            browser.reload_ignore_cache();
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
