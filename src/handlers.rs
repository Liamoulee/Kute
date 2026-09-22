use crate::{app, bridge, constants, debug_print, modules, utils, utils::config, window};
use cef::{rc::*, *};
use std::sync::{LazyLock, Mutex, mpsc};

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

// a mod page a popup asked for, loaded in the main window once on_before_popup has returned
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
            // the player's own swapper folder first: their file beats ours for the same request
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
#[cfg(feature = "audio-log")]
const VK_F9: i32 = 0x78;
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
            #[cfg(feature = "audio-log")]
            if event.windows_key_code == VK_F9 {
                window::handle_accelerator_key(browser, VK_F9 as u16);
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

// mirrors SetAllowExternalDrop(false). CEF only asks this for Alloy style browsers, Kute's are Chrome style, so
// external drops reach the page and the managers read the dropped files there (managers/popup.js)
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
            // the "Use" button of a mod's detail view opens the game page with the mod (krunker.io/?mod=...): in a
            // browser that is a new tab, here it was a second game window, and Krunker allows one session per
            // account, so the first window lost its match. The main window loads it
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
                // a same origin popup keeps the initial window and swaps the document, so the social
                // userscripts are registered per document (like WebView2 did) instead of per V8 context
                if config("userscripts", true) {
                    // one document script per userscript, so a syntax error in one does not take the others along
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

// the manager commands write files, so a page that is not Krunker (a mod page in the main window, a hijacked
// navigation) must not reach them: it could plant a userscript that runs in every later session
fn is_krunker_frame(frame: &Frame) -> bool {
    let url = utils::cef_to_string(&frame.url());
    url.starts_with("https://") && utils::krunker_path(&url).is_some()
}

fn payload_str<'a>(payload: &'a serde_json::Value, key: &str) -> &'a str {
    payload[key].as_str().unwrap_or_default()
}

// the userscript and swapper managers read, write and walk files: uploads of up to 32 MB, whole swapper packs, the
// recycle bin. One worker thread takes their commands in the order they came, so the UI thread (the window, input,
// every other message) never waits on a disk, and two reloads of the swapper never race each other
static MANAGER_QUEUE: LazyLock<Option<mpsc::Sender<(i32, String)>>> = LazyLock::new(|| {
    let (sender, receiver) = mpsc::channel::<(i32, String)>();
    std::thread::Builder::new()
        .name("kute-managers".into())
        .spawn(move || {
            for (browser_id, message) in receiver {
                let reply = match message.split_once('-') {
                    Some(("scripts", rest)) => handle_scripts_message(rest),
                    Some(("swapper", rest)) => handle_swapper_message(rest),
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

// the reply every command ends with: the fresh list, plus {managerError} when something did not work, so the popup
// always shows what is on disk
fn manager_reply(key: &str, list: serde_json::Value, problems: &[String]) -> Option<String> {
    let mut reply = serde_json::json!({ key: list });
    if !problems.is_empty() {
        reply["managerError"] = serde_json::json!(problems.join("\n"));
    }
    Some(reply.to_string())
}

// "scripts-<command> <json>": the userscript manager, on the manager thread
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
            // an import of many scripts asks for the list once at the end instead of once per script
            if payload["noList"].as_bool() == Some(true) {
                return (!problems.is_empty()).then(|| serde_json::json!({ "managerError": problems.join("\n") }).to_string());
            }
        }
        "toggle" => userscripts::set_enabled(key, payload["enabled"].as_bool().unwrap_or(true)),
        "prefs" => {
            userscripts::set_prefs(key, payload["prefs"].clone());
            // the page already shows the change, no list needed
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

// "swapper-<command> <json>": the swapper manager, on the manager thread
fn handle_swapper_message(message: &str) -> Option<String> {
    use modules::swapper;
    let (command, payload) = message.split_once(' ').unwrap_or((message, "{}"));
    let payload = serde_json::from_str::<serde_json::Value>(payload).ok()?;
    let path = payload_str(&payload, "path");
    let mut problems: Vec<String> = Vec::new();
    match command {
        // files the player put in with Explorer count from the next refresh on, like the ones added here. The reload
        // is done before the reply leaves, so a refresh after it gets the new files
        "list" => swapper::reload(),
        "mkdir" => problems.extend(swapper::make_dir(path).err()),
        "delete" => problems.extend(swapper::delete(path).err()),
        "move" => problems.extend(swapper::move_to(payload_str(&payload, "from"), payload_str(&payload, "to")).err()),
        // one dropped file, base64. Acknowledged on its own, the page sends the next one only then (one file in flight
        // instead of a pack in memory), and asks for the list once at the end
        "upload" => {
            let result = swapper::upload(path, payload_str(&payload, "data"));
            let error = result.err().map(|e| format!("{path}: {e}"));
            return Some(serde_json::json!({ "swapperUploaded": { "path": path, "error": error } }).to_string());
        }
        "reveal" => {
            swapper::reveal(path);
            return None;
        }
        _ => return None,
    }
    manager_reply("swapper", swapper::list(), &problems)
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
    // the start is enough to see which command it was: a swapper upload is a whole file as base64
    if message_string.len() > 300 {
        let cut = (0..=300).rev().find(|&index| message_string.is_char_boundary(index)).unwrap_or(0);
        debug_print!("web message: {}... ({} bytes)", &message_string[..cut], message_string.len());
    } else {
        debug_print!("web message: {message_string}");
    }
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
    // "icon-urls <json>": the images the player pointed the icon slots at, so Kute icons answer those too
    if let Some(rest) = message_string.strip_prefix("icon-urls ") {
        if rest.len() <= 16 * 1024
            && let Ok(value) = serde_json::from_str::<serde_json::Value>(rest)
        {
            modules::icons::set_player_urls(&value);
        }
        return;
    }
    // the audio test build's page module: "audio-log <json>", one line or one block of the log
    #[cfg(feature = "audio-log")]
    if let Some(rest) = message_string.strip_prefix("audio-log ") {
        if rest.len() <= 8 * 1024 {
            modules::audio_log::page(rest);
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
    // the userscript and swapper managers: JSON payloads, only from Krunker itself
    if let Some(rest) = message_string.strip_prefix("scripts-") {
        if is_krunker_frame(frame) && rest.len() <= 5 * 1024 * 1024 {
            queue_manager_message(browser, message_string);
        }
        return;
    }
    if let Some(rest) = message_string.strip_prefix("swapper-") {
        // an upload carries a whole file (base64), everything else is a short command
        if is_krunker_frame(frame) && rest.len() <= 48 * 1024 * 1024 {
            queue_manager_message(browser, message_string);
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
            // take_present_intervals waits for the hook's next present (up to 150 ms): not on the UI thread
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
        // the page keeps the images it already has, so a changed icon only shows after this. Never "clear-cache"
        // for that: it also wipes the origin's storage, which is every Krunker setting the player has
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
