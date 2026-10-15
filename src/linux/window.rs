// cef views: on ozone cef owns the top level window, a foreign parent is unsupported (cef issue 2804)
use crate::{app, bridge, debug_print, handlers, modules, modules::hotkeys::Action, utils, utils::config};
use cef::*;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

static WINDOW_COUNT: AtomicUsize = AtomicUsize::new(0);
// the input replay's thread asks, cef windows are ui thread only
static MAIN_ACTIVE: AtomicBool = AtomicBool::new(false);
static BROWSER_COUNT: AtomicUsize = AtomicUsize::new(0);
const RENDER_STATS_MS: i64 = 100;
const ICON_PNG: &[u8] = include_bytes!("../../resources/kute-256.png");

// cef objects are UI thread only
thread_local! {
    static BROWSERS: RefCell<HashMap<i32, Browser>> = RefCell::new(HashMap::new());
    static BROWSER_WINDOWS: RefCell<HashMap<i32, Window>> = RefCell::new(HashMap::new());
    static MAIN_BROWSER: RefCell<Option<Browser>> = const { RefCell::new(None) };
    static OUR_WINDOWS: RefCell<Vec<Window>> = const { RefCell::new(Vec::new()) };
    // on_before_popup knows the size, on_popup_browser_view_created makes the window
    static PENDING_POPUP: Cell<Option<WindowState>> = const { Cell::new(None) };
    static STATS_RUNNING: Cell<bool> = const { Cell::new(false) };
}

#[derive(Copy, Clone, serde::Serialize, serde::Deserialize, Default, Debug)]
pub struct Position {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Copy, Clone, serde::Serialize, serde::Deserialize, Default, Debug)]
pub struct WindowState {
    pub fullscreen: bool,
    // position is the restore size, this maximizes on top of it
    #[serde(default)]
    pub maximized: bool,
    pub position: Position,
}

fn has_position(state: &WindowState) -> bool {
    state.position.right > state.position.left && state.position.bottom > state.position.top
}

// 80 % of the primary display's work area, centered
fn windowed_position() -> Position {
    let area = display_get_primary().map(|display| display.work_area()).unwrap_or(Rect {
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
    });
    let width = (area.width as f32 * 0.8) as i32;
    let height = (area.height as f32 * 0.8) as i32;
    let left = area.x + (area.width - width) / 2;
    let top = area.y + (area.height - height) / 2;
    Position {
        left,
        top,
        right: left + width,
        bottom: top + height,
    }
}

fn creation_state(start_mode: &str, init_state: Option<WindowState>) -> WindowState {
    let windowed = |fullscreen: bool, maximized: bool| WindowState {
        fullscreen,
        maximized,
        position: windowed_position(),
    };
    match start_mode {
        "Borderless Fullscreen" => windowed(true, false),
        "Maximized" => windowed(false, true),
        "Remember Previous" | "Custom" => init_state.filter(has_position).unwrap_or_else(|| {
            if start_mode == "Custom" {
                windowed(false, false)
            } else {
                windowed(true, false)
            }
        }),
        _ => windowed(false, false),
    }
}

// cef-rs writes an owned CefString in an out-parameter struct back as an empty string (cef 151.5.0, string.rs),
// only a borrowed one survives. leaked once per window, cef copies it and has no destructor to call
fn borrowed_cef_string(text: &str) -> CefString {
    let utf16: &'static [u16] = Box::leak(text.encode_utf16().collect::<Vec<u16>>().into_boxed_slice());
    CefString::from(sys::_cef_string_utf16_t {
        str_: utf16.as_ptr() as *mut _,
        length: utf16.len(),
        dtor: None,
    })
}

fn bench_locked() -> bool {
    modules::bench::config().is_some_and(|bench| bench.locked)
}

// the auto-detect bench covers the client: no focus, no taskbar entry, clicks go through. x11 only, cef views has no
// inactive show, and on native wayland a client cannot ask for any of this
fn lock_bench_window(handle: u64) -> Option<()> {
    use x11rb::{
        connection::Connection,
        protocol::xproto::{AtomEnum, ClientMessageEvent, ConnectionExt as _, EventMask, PropMode},
        wrapper::ConnectionExt as _,
    };
    let window = u32::try_from(handle).ok().filter(|&window| window != 0)?;
    let (connection, screen) = x11rb::connect(None).ok()?;
    let root = connection.setup().roots.get(screen)?.root;
    let atom = |name: &str| Some(connection.intern_atom(false, name.as_bytes()).ok()?.reply().ok()?.atom);
    // WM_HINTS: InputHint set, input false. the window manager then never gives it the keyboard
    connection
        .change_property32(PropMode::REPLACE, window, AtomEnum::WM_HINTS, AtomEnum::WM_HINTS, &[1, 0, 0, 0, 0, 0, 0, 0, 0])
        .ok()?;
    let state = atom("_NET_WM_STATE")?;
    let skip = [atom("_NET_WM_STATE_SKIP_TASKBAR")?, atom("_NET_WM_STATE_SKIP_PAGER")?];
    // before the map a property, after it only a request to the window manager counts
    connection.change_property32(PropMode::APPEND, window, state, AtomEnum::ATOM, &skip).ok()?;
    // 1: _NET_WM_STATE_ADD
    let request = ClientMessageEvent::new(32, window, state, [1, skip[0], skip[1], 1, 0]);
    connection
        .send_event(false, root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, request)
        .ok()?;
    connection.flush().ok()?;
    pass_input_through(handle)
}

// an empty input shape. chromium sets the window's input region again after a bounds change, so this follows each one
fn pass_input_through(handle: u64) -> Option<()> {
    use x11rb::{connection::Connection, protocol::shape::SK, protocol::xfixes::ConnectionExt as _};
    let window = u32::try_from(handle).ok().filter(|&window| window != 0)?;
    let (connection, _) = x11rb::connect(None).ok()?;
    connection.xfixes_query_version(5, 0).ok()?.reply().ok()?;
    let region = connection.generate_id().ok()?;
    connection.xfixes_create_region(region, &[]).ok()?;
    connection.xfixes_set_window_shape_region(window, SK::INPUT, 0, 0, region).ok()?;
    connection.xfixes_destroy_region(region).ok()?;
    connection.flush().ok()?;
    Some(())
}

fn window_icon() -> Option<Image> {
    let image = image_create()?;
    (image.add_png(1.0, Some(ICON_PNG)) != 0).then_some(image)
}

wrap_window_delegate! {
    struct KuteWindowDelegate {
        browser_view: BrowserView,
        is_main: bool,
        state: Rc<Cell<WindowState>>,
    }

    impl ViewDelegate {}

    impl PanelDelegate {}

    impl WindowDelegate {
        fn on_window_created(&self, window: Option<&mut Window>) {
            let Some(window) = window else { return };
            WINDOW_COUNT.fetch_add(1, Ordering::SeqCst);
            OUR_WINDOWS.with_borrow_mut(|windows| windows.push(window.clone()));
            let mut view = View::from(&self.browser_view);
            window.add_child_view(Some(&mut view));
            window.set_title(Some(&CefString::from("Kute")));
            if let Some(mut icon) = window_icon() {
                window.set_window_icon(Some(&mut icon));
                window.set_window_app_icon(Some(&mut icon));
            }
            let locked = bench_locked();
            if locked {
                lock_bench_window(window.window_handle());
            }
            window.show();
            if self.state.get().fullscreen {
                window.set_fullscreen(1);
            }
            if locked {
                // chromium writes its own _NET_WM_STATE when it maps the window
                lock_bench_window(window.window_handle());
            } else {
                self.browser_view.request_focus();
            }
        }

        fn on_window_destroyed(&self, window: Option<&mut Window>) {
            if let Some(window) = window.as_deref() {
                OUR_WINDOWS.with_borrow_mut(|windows| windows.retain(|known| known.is_same(Some(&mut View::from(window))) == 0));
            }
            if self.is_main && !modules::bench::active() {
                crate::CONFIG.lock().unwrap().set("lastPosition", self.state.get());
            }
            let count = WINDOW_COUNT.fetch_sub(1, Ordering::SeqCst);
            debug_print!("window: destroyed, {} left", count - 1);
            if count == 1 && BROWSER_COUNT.load(Ordering::SeqCst) == 0 {
                debug_print!("window: last window destroyed, quitting");
                quit_message_loop();
            }
        }

        fn is_frameless(&self, _window: Option<&mut Window>) -> ::std::os::raw::c_int {
            bench_locked() as ::std::os::raw::c_int
        }

        // asks cef first, the window closes once the browser is gone
        fn can_close(&self, _window: Option<&mut Window>) -> ::std::os::raw::c_int {
            match self.browser_view.browser().and_then(|browser| browser.host()) {
                Some(host) => host.try_close_browser(),
                None => 1,
            }
        }

        // cef-rs defaults every callback to 0, cef's own default for these is true
        fn can_resize(&self, _window: Option<&mut Window>) -> ::std::os::raw::c_int {
            1
        }

        fn can_maximize(&self, _window: Option<&mut Window>) -> ::std::os::raw::c_int {
            1
        }

        fn can_minimize(&self, _window: Option<&mut Window>) -> ::std::os::raw::c_int {
            1
        }

        fn initial_bounds(&self, _window: Option<&mut Window>) -> Rect {
            let position = self.state.get().position;
            Rect {
                x: position.left,
                y: position.top,
                width: position.right - position.left,
                height: position.bottom - position.top,
            }
        }

        fn initial_show_state(&self, _window: Option<&mut Window>) -> ShowState {
            let state = self.state.get();
            if state.maximized && !state.fullscreen { ShowState::MAXIMIZED } else { ShowState::NORMAL }
        }

        // only the restore size is remembered, like GetWindowPlacement's rcNormalPosition
        fn on_window_bounds_changed(&self, window: Option<&mut Window>, new_bounds: Option<&Rect>) {
            let (Some(window), Some(bounds)) = (window, new_bounds) else { return };
            let mut state = self.state.get();
            state.maximized = window.is_maximized() != 0;
            if window.is_fullscreen() == 0 && !state.maximized && window.is_minimized() == 0 {
                state.position = Position {
                    left: bounds.x,
                    top: bounds.y,
                    right: bounds.x + bounds.width,
                    bottom: bounds.y + bounds.height,
                };
            }
            self.state.set(state);
            if bench_locked() {
                pass_input_through_later(window.window_handle());
            }
        }

        fn on_window_activation_changed(&self, _window: Option<&mut Window>, active: ::std::os::raw::c_int) {
            if self.is_main {
                MAIN_ACTIVE.store(active != 0, Ordering::Relaxed);
            }
        }

        fn on_window_fullscreen_transition(&self, window: Option<&mut Window>, is_completed: ::std::os::raw::c_int) {
            if let (Some(window), 1) = (window, is_completed) {
                if bench_locked() {
                    pass_input_through_later(window.window_handle());
                }
                let mut state = self.state.get();
                state.fullscreen = window.is_fullscreen() != 0;
                self.state.set(state);
            }
        }

        // x11 WM_CLASS and the wayland app id, what a .desktop file's StartupWMClass matches
        fn linux_window_properties(&self, _window: Option<&mut Window>, properties: Option<&mut LinuxWindowProperties>) -> ::std::os::raw::c_int {
            let Some(properties) = properties else { return 0 };
            let class = if modules::bench::active() { "kute-bench" } else { "kute" };
            properties.wayland_app_id = borrowed_cef_string(class);
            properties.wm_class_class = borrowed_cef_string("Kute");
            properties.wm_class_name = borrowed_cef_string(class);
            1
        }
    }
}

wrap_browser_view_delegate! {
    struct KuteBrowserViewDelegate {}

    impl ViewDelegate {}

    impl BrowserViewDelegate {
        fn delegate_for_popup_browser_view(
            &self,
            _browser_view: Option<&mut BrowserView>,
            _settings: Option<&BrowserSettings>,
            _client: Option<&mut Client>,
            _is_devtools: ::std::os::raw::c_int,
        ) -> Option<BrowserViewDelegate> {
            Some(KuteBrowserViewDelegate::new())
        }

        fn on_popup_browser_view_created(
            &self,
            _browser_view: Option<&mut BrowserView>,
            popup_browser_view: Option<&mut BrowserView>,
            _is_devtools: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int {
            let Some(popup) = popup_browser_view else { return 0 };
            let state = creation_state("Custom", PENDING_POPUP.take());
            open_window(popup.clone(), false, state);
            1
        }
    }
}

fn open_window(browser_view: BrowserView, is_main: bool, state: WindowState) {
    let mut delegate = KuteWindowDelegate::new(browser_view, is_main, Rc::new(Cell::new(state)));
    if window_create_top_level(Some(&mut delegate)).is_none() {
        eprintln!("window_create_top_level failed");
    }
}

fn window_of(browser: &Browser) -> Option<Window> {
    BROWSER_WINDOWS.with_borrow(|windows| windows.get(&browser.identifier()).cloned()).or_else(|| {
        let mut browser = browser.clone();
        browser_view_get_for_browser(Some(&mut browser))?.window()
    })
}

// the game's window has the keyboard focus, what GetForegroundWindow tells the windows replay
pub fn main_window_active() -> bool {
    MAIN_ACTIVE.load(Ordering::Relaxed)
}

// x11 window id (0 on native wayland), read by specs and the input replay
pub fn root_hwnd(browser: &Browser) -> Option<u64> {
    window_of(browser).map(|window| window.window_handle())
}

// physical px per css px of the screen the window is on
pub fn device_scale(browser: &Browser) -> f64 {
    window_of(browser)
        .and_then(|window| window.display())
        .map(|display| display.device_scale_factor() as f64)
        .filter(|scale| *scale > 0.0)
        .unwrap_or(1.0)
}

// a hidden page stops rendering. hiding the view drops the page's focus for good: request_focus, set_focus and an
// activate (with x11 focus on our window the whole time) left document.hasFocus() false, and chromium refused auto-detect's
// spawn click the pointer lock (WrongDocumentError). devtools' Page.bringToFront is what gives it back
pub fn set_browser_visible(browser: &Browser, visible: bool) {
    let Some(host) = browser.host() else { return };
    let mut browser = browser.clone();
    if let Some(view) = browser_view_get_for_browser(Some(&mut browser)) {
        view.set_visible(visible as i32);
    }
    host.was_hidden((!visible) as i32);
    if visible {
        host.set_focus(1);
        modules::devtools::bring_to_front(&browser);
    }
}

pub fn bring_to_front(browser: &Browser) {
    let Some(window) = window_of(browser) else { return };
    if window.is_minimized() != 0 {
        window.restore();
    }
    window.activate();
    window.bring_to_top();
    if let Some(host) = browser.host() {
        host.set_focus(1);
    }
}

// client area in screen coordinates (dip), [left, top, right, bottom]
pub fn client_rect_on_screen(browser: &Browser) -> Option<[i32; 4]> {
    let rect = window_of(browser)?.client_area_bounds_in_screen();
    Some([rect.x, rect.y, rect.x + rect.width, rect.y + rect.height])
}

pub fn browser_by_id(id: i32) -> Option<Browser> {
    BROWSERS.with_borrow(|b| b.get(&id).cloned())
}

// krunker.io/?mod=<name>, opened by a mod's "Use" button
pub fn is_mod_page(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://krunker.io") else { return false };
    let Some(query) = rest.strip_prefix("/?").or_else(|| rest.strip_prefix('?')) else {
        return false;
    };
    query.split('#').next().unwrap_or("").split('&').any(|pair| pair.split('=').next() == Some("mod"))
}

pub fn has_main_browser() -> bool {
    MAIN_BROWSER.with_borrow(|b| b.is_some())
}

// same as F4 does it: throttle off, pointer released, window to the front
pub fn load_in_main(url: &str) {
    let Some(browser) = MAIN_BROWSER.with_borrow(|b| b.clone()) else { return };
    modules::devtools::set_cpu_throttling(&browser, 1.0);
    if let Some(frame) = browser.main_frame() {
        frame.load_url(Some(&CefString::from(url)));
    }
    modules::input::set_pointer_locked(false);
    bring_to_front(&browser);
}

wrap_task! {
    struct RenderStatsTask {
        last: Rc<Cell<Option<(u64, u64)>>>,
    }

    impl Task {
        fn execute(&self) {
            let Some(browser) = MAIN_BROWSER.with_borrow(|b| b.clone()) else {
                STATS_RUNNING.set(false);
                return;
            };
            if let Some(current) = app::render_stats()
                && current.0 > 0
                && self.last.get() != Some(current)
            {
                self.last.set(Some(current));
                bridge::post_json(&browser, &format!("{{\"fpsInfo\":{}}}", current.0));
            }
            let mut next = RenderStatsTask::new(self.last.clone());
            post_delayed_task(ThreadId::UI, Some(&mut next), RENDER_STATS_MS);
        }
    }
}

wrap_task! {
    struct InputShapeTask {
        handle: u64,
    }

    impl Task {
        fn execute(&self) {
            pass_input_through(self.handle);
        }
    }
}

// chromium resets the input region after the delegate callbacks, measured: a direct call was undone every time
fn pass_input_through_later(handle: u64) {
    let mut task = InputShapeTask::new(handle);
    post_delayed_task(ThreadId::UI, Some(&mut task), 200);
}

fn start_render_stats() {
    if STATS_RUNNING.replace(true) {
        return;
    }
    let mut task = RenderStatsTask::new(Rc::new(Cell::new(None)));
    post_delayed_task(ThreadId::UI, Some(&mut task), RENDER_STATS_MS);
}

pub fn attach_browser(browser: &Browser) {
    BROWSER_COUNT.fetch_add(1, Ordering::SeqCst);
    BROWSERS.with_borrow_mut(|b| b.insert(browser.identifier(), browser.clone()));

    // not ours, chromium acting on its own (session restore etc)
    let Some(window) = window_of(browser) else {
        debug_print!("window: browser {} has no kute window, closing it", browser.identifier());
        if let Some(host) = browser.host() {
            host.close_browser(1);
        }
        return;
    };
    BROWSER_WINDOWS.with_borrow_mut(|m| m.insert(browser.identifier(), window));

    if browser.is_popup() == 0 {
        MAIN_BROWSER.set(Some(browser.clone()));
        if let Some(bench) = modules::bench::config() {
            modules::devtools::set_cpu_throttling(browser, bench.throttle);
            return;
        }
        modules::priority::set(config("webviewPriority", "Normal".to_string()));
        if config("realPing", false) {
            modules::ping::load(browser);
        }
        if config("renderStats", false) {
            start_render_stats();
        }
    }
}

pub fn mark_closing(browser: &Browser) {
    debug_print!("window: browser {} closing", browser.identifier());
}

pub fn detach_browser(browser: &Browser) {
    let id = browser.identifier();
    debug_print!("window: browser {id} closed");
    BROWSERS.with_borrow_mut(|b| b.remove(&id));
    if MAIN_BROWSER.with_borrow(|b| b.as_ref().is_some_and(|m| m.identifier() == id)) {
        MAIN_BROWSER.set(None);
    }
    // the page closed itself (window.close()), the window follows
    if let Some(window) = BROWSER_WINDOWS.with_borrow_mut(|m| m.remove(&id))
        && window.is_closed() == 0
    {
        window.close();
    }
    if BROWSER_COUNT.fetch_sub(1, Ordering::SeqCst) == 1 && WINDOW_COUNT.load(Ordering::SeqCst) == 0 {
        debug_print!("window: last browser closed, quitting");
        quit_message_loop();
    }
}

// same path as the title bar's close button, can_close asks cef first
pub fn close_window(browser: &Browser) {
    if let Some(window) = window_of(browser) {
        window.close();
    }
}

pub fn close_all() {
    let windows: Vec<Window> = OUR_WINDOWS.with_borrow(|w| w.clone());
    for window in windows {
        window.close();
    }
}

pub fn handle_accelerator_key(browser: &Browser, action: Action) {
    match action {
        // matchmaker.js handles it
        Action::Matchmaker if utils::config("matchmaker", true) => {}
        Action::NewLobby | Action::Matchmaker => {
            modules::devtools::set_cpu_throttling(browser, 1.0);
            if let Some(frame) = browser.main_frame() {
                let current_url = utils::cef_to_string(&frame.url());
                let target_url = current_url
                    .split_once("game=")
                    .map(|(_before, after)| after.trim())
                    .filter(|id| !id.is_empty())
                    .map(|id| format!("https://krunker.io/?exclude={}", id))
                    .unwrap_or_else(|| "https://krunker.io/".to_string());
                frame.load_url(Some(&CefString::from(target_url.as_str())));
            }
            modules::input::set_pointer_locked(false);
        }
        Action::Reload => {
            modules::devtools::set_cpu_throttling(browser, 1.0);
            browser.reload();
            modules::input::set_pointer_locked(false);
        }
        Action::Fullscreen => {
            if let Some(window) = window_of(browser) {
                window.set_fullscreen((window.is_fullscreen() == 0) as i32);
            }
        }
        Action::DevTools => {
            if let Some(host) = browser.host() {
                host.show_dev_tools(None, None, None, None);
            }
        }
    }
}

wrap_task! {
    struct PostToMainTask {
        json: String,
    }

    impl Task {
        fn execute(&self) {
            if let Some(browser) = MAIN_BROWSER.with_borrow(|b| b.clone()) {
                bridge::post_json(&browser, &self.json);
            }
        }
    }
}

// any thread, dropped while there is no game page
pub fn post_to_main(json: String) {
    let mut task = PostToMainTask::new(json);
    post_task(ThreadId::UI, Some(&mut task));
}

// args from a second instance (instance.rs), what WM_COPYDATA does on windows
pub fn receive_args(args: &str) {
    match MAIN_BROWSER.with_borrow(|b| b.clone()) {
        Some(browser) => {
            if !args.is_empty() {
                let string = serde_json::to_string(args).unwrap_or_default();
                bridge::post_json(&browser, &format!("{{\"args\":{}}}", string));
            }
            bring_to_front(&browser);
        }
        // only social is left, bring the game back
        None => {
            handlers::set_pending_args(args.to_string());
            create_main_window();
        }
    }
}

pub fn create_main_window() {
    let bench = modules::bench::config();
    let state = match bench.and_then(|bench| bench.rect) {
        Some([left, top, right, bottom]) => WindowState {
            fullscreen: bench_locked(),
            maximized: false,
            position: Position { left, top, right, bottom },
        },
        None => {
            let start_mode = config("startMode", "Remember Previous".to_string());
            let remembered = if start_mode == "Remember Previous" {
                config("lastPosition", None::<WindowState>)
            } else {
                None
            };
            creation_state(&start_mode, remembered)
        }
    };
    let url = if modules::bench::active() {
        modules::bench::url()
    } else {
        crate::constants::KRUNKER_URL.to_string()
    };

    let mut client = handlers::KuteClient::new();
    let mut request_context = app::request_context();
    let mut delegate = KuteBrowserViewDelegate::new();
    let Some(browser_view) = browser_view_create(
        Some(&mut client),
        Some(&CefString::from(url.as_str())),
        Some(&app::browser_settings()),
        None,
        request_context.as_mut(),
        Some(&mut delegate),
    ) else {
        eprintln!("browser_view_create failed");
        return;
    };
    open_window(browser_view, true, state);
}

// views makes the popup's window in on_popup_browser_view_created, this only keeps the requested size for it
pub fn create_popup_window(
    features: Option<&PopupFeatures>,
    _window_info: Option<&mut WindowInfo>,
    client: Option<&mut Option<Client>>,
    settings: Option<&mut BrowserSettings>,
) {
    let mut state = None;
    if let Some(features) = features
        && (features.x_set != 0 || features.y_set != 0 || features.width_set != 0 || features.height_set != 0)
    {
        let fallback = windowed_position();
        let width = if features.width_set != 0 {
            features.width
        } else {
            fallback.right - fallback.left
        };
        let height = if features.height_set != 0 {
            features.height
        } else {
            fallback.bottom - fallback.top
        };
        let left = if features.x_set != 0 { features.x } else { fallback.left };
        let top = if features.y_set != 0 { features.y } else { fallback.top };
        state = Some(WindowState {
            fullscreen: false,
            maximized: false,
            position: Position {
                left,
                top,
                right: left + width,
                bottom: top + height,
            },
        });
    }
    PENDING_POPUP.set(state);
    if let Some(client) = client {
        *client = Some(handlers::KuteClient::new());
    }
    if let Some(settings) = settings {
        *settings = app::browser_settings();
    }
}
