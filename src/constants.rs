pub const DISCORD_CLIENT_ID: &str = "1549875633276981249";
pub const UPDATE_URL: &str = "https://api.github.com/repos/NullDev/Kute/releases/latest";
// the only place "open-url" may lead to, the page cannot send the user anywhere else
pub const GITHUB_URL: &str = "https://github.com/";
pub const JS_VERSION_URL: &str = "https://raw.githubusercontent.com/NullDev/Kute/master/target/bundle_version";
pub const JS_BUNDLE_URL: &str = "https://raw.githubusercontent.com/NullDev/Kute/master/target/bundle.js";
pub const INSTANCE_MUTEX: &str = "Global\\9e29aac4-cd01-442b-bec2-ddd99403ca14";
pub const KRUNKER_URL: &str = "https://krunker.io";

// process message names between the browser process and the renderer
pub const MSG_TO_PAGE: &str = "kute-message";
pub const MSG_FROM_PAGE: &str = "kute-post";

pub const DEFAULT_BLOCKLIST: &str = r#"[
	"*://*.pollfish.com/*",
	"*://*.paypalobjects.com/*",
	"*://c.amazon-adsystem.com/*",
  "*://config.aps.amazon-adsystem.com/*",
  "*://securepubads.g.doubleclick.net/*",
  "*://cookiepro.com/*",
  "*://*.cookiepro.com/*",
  "*://cdn.ravenjs.com/*",
  "*://*.poll.fish/*",
  "*://*.paypal.com/*",
  "*://*.twitter.com/*",
  "*://*.youtube.com/*",
  "*://*.doubleclick.net/*",
  "*://unpkg.com/web3*",
  "*://storage.googleapis.com/pollfish_production/*",
  "*://*.googletagmanager.com/*",
  "*://apis.google.com/js/platform.js",
  "*://imasdk.googleapis.com/*",
  "*://*.googlesyndication.com/*",
  "*://www.google-analytics.com/*",
  "*://krunker.io/manifest.json*",
  "*://krunker.io/css/google-play.css*",
  "*://krunker.io/img/btc_icn.png*",
  "*://krunker.io/img/app_1.png*",
  "*://krunker.io/img/app_0.png.png*",
  "*://krunker.io/libs/chart.bundle*",
  "*://krunker.io/img/muzflash.png*",
  "*://krunker.io/service-worker.js*",
  "*://krunker.io/libs/fflate*",
  "*://krunker.io/libs/purejscarousel*",
  "*://assets.krunker.io/sound/ambient_*",
  "*://assets.krunker.io/models/clouds_0.obj*",
  "*://krunker.io/img/client.png*",
  "*://krunker.io/libs/nipplejs.min.js*",
  "*://user-assets.krunker.io/60585/*",
  "*://fran-cdn.frvr.com/prebid*",
  "*://cdn.frvr.com/fran/prebid*",
  "*://krunker.io/libs/anzu.js*",
  "*://user-assets.krunker.io/61822/model.obj*",
  "*://user-assets.krunker.io/61818/model.obj*",
  "*://user-assets.krunker.io/61814/model.obj*",
  "*://user-assets.krunker.io/61824/model.obj*",
  "*://user-assets.krunker.io/61815/model.obj*",
  "*://user-assets.krunker.io/61820/model.obj*",
  "*://user-assets.krunker.io/61821/model.obj*",
  "*://user-assets.krunker.io/61806/model.obj*",
  "*://user-assets.krunker.io/61823/model.obj*"
]"#;

// every entry is checked against the Chromium 151.0.7922.174 source (switch or feature exists and is read on Windows under CEF),
// check them again when the cef crate is bumped. --raise-timer-frequency is applied by utils::raise_timer_frequency,
// chromium only reads it in chrome.exe
pub const DEFAULT_FLAGS: &str = r#"[
  "--disable-features=NativeNotifications,MediaRouter,CalculateNativeWinOcclusion,HappinessTrackingSurveysForDesktopDemo,HardwareMediaKeyHandling",
  "--disable-backgrounding-occluded-windows",
  "--force-high-performance-gpu",
  "--ui-disable-partial-swap",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  "--enable-gpu-rasterization",
  "--enable-webgl-draft-extensions",
  "--enable-zero-copy",
  "--enable-unsafe-webgpu",
  "--disable-2d-canvas-clip-aa",
  "--disable-composited-antialiasing",
  "--disable-software-rasterizer",
  "--disable-mipmap-generation",
  "--enable-native-gpu-memory-buffers",
  "--disable-gpu-driver-bug-workarounds",
  "--disable-gpu-watchdog",
  "--enable-features=SharedArrayBuffer,V8VmFuture",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-best-effort-tasks",
  "--raise-timer-frequency",
  "--wm-window-animations-disabled",
  "--disable-low-end-device-mode",
  "--enable-quic",
  "--quic-max-packet-length=1460",
  "--no-proxy-server",
  "--no-pings",
  "--disable-background-networking",
  "--disable-domain-reliability",
  "--disable-hang-monitor",
  "--disable-breakpad",
  "--disable-oopr-debug-crash-dump",
  "--disable-in-process-stack-traces",
  "--disable-component-update",
  "--autoplay-policy=no-user-gesture-required"
]"#;
