// bundle hot updates, and new client versions as a new AppImage. the page asks (linuxUpdate.js), nothing closes the client
use crate::{constants, debug_print, utils, window};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{Read, Write},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

// the exe's own bundle, a downloaded one only counts when it is newer: it outlives an exe update here
const EMBEDDED_VERSION: &str = include_str!("../../target/bundle_version");
const PROGRESS_EVERY: Duration = Duration::from_millis(500);

#[derive(Clone)]
struct Asset {
    url: String,
    size: u64,
    sha256: String,
}

struct Release {
    version: semver::Version,
    asset: Option<Asset>,
}

// what the page sees as {update}, resent on "update-state" after a page load
static STATE: Mutex<Option<serde_json::Value>> = Mutex::new(None);
static OFFER: Mutex<Option<(semver::Version, Asset)>> = Mutex::new(None);
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static READY: AtomicBool = AtomicBool::new(false);

// next to the exe is read only in an AppImage
fn bundle_dir() -> PathBuf {
    utils::settings_dir().join("bundle")
}

fn parse(text: &str) -> Option<semver::Version> {
    semver::Version::parse(text.trim()).ok()
}

fn downloaded_version() -> Option<semver::Version> {
    parse(&fs::read_to_string(bundle_dir().join("bundle_version")).ok()?)
}

// renderer, every page load
pub fn downloaded_bundle() -> Option<String> {
    if downloaded_version()? <= parse(EMBEDDED_VERSION)? {
        return None;
    }
    fs::read_to_string(bundle_dir().join("bundle.js")).ok().filter(|bundle| !bundle.is_empty())
}

fn agent(timeout: Option<Duration>) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(20)))
        .timeout_global(timeout)
        .build()
        .into()
}

fn get_string(url: &str) -> Option<String> {
    let mut text = String::new();
    agent(Some(Duration::from_secs(30)))
        .get(url)
        .call()
        .ok()?
        .into_body()
        .as_reader()
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

// dev builds only: a local release json, its downloads may point anywhere
fn test_release_url() -> Option<String> {
    #[cfg(feature = "verbose-logs")]
    return env::var("KUTE_UPDATE_URL").ok();
    #[allow(unreachable_code)]
    None
}

// the running AppImage file, set by the AppImage runtime. None for a plain build, which cannot update itself
fn appimage() -> Option<PathBuf> {
    env::var_os("APPIMAGE").map(PathBuf::from).filter(|path| path.is_file())
}

pub fn run() {
    check_bundle();
    check_release();
}

// a new bundle applies on the next navigation
fn check_bundle() {
    let Some(embedded) = parse(EMBEDDED_VERSION) else { return };
    let current = downloaded_version().filter(|version| *version > embedded).unwrap_or(embedded);
    *crate::JS_VERSION.lock().unwrap() = current.to_string();

    let Some(latest_text) = get_string(constants::JS_VERSION_URL) else { return };
    let Some(latest) = parse(&latest_text) else { return };
    if latest <= current {
        return;
    }
    let Some(bundle) = get_string(constants::JS_BUNDLE_URL) else { return };
    fs::create_dir_all(bundle_dir()).ok();
    // version last: a bundle without its version is never picked up
    if utils::atomic_write(&bundle_dir().join("bundle.js"), &bundle).is_ok()
        && utils::atomic_write(&bundle_dir().join("bundle_version"), &latest_text.trim()).is_ok()
    {
        *crate::JS_VERSION.lock().unwrap() = latest.to_string();
    }
}

fn latest_release() -> Option<Release> {
    let url = test_release_url().unwrap_or_else(|| constants::UPDATE_URL.to_string());
    let json = serde_json::from_str::<serde_json::Value>(&get_string(&url)?).ok()?;
    let version = parse(json["tag_name"].as_str()?)?;
    // by exact name, and only with a checksum to verify against
    let asset = json["assets"].as_array().and_then(|assets| {
        let asset = assets.iter().find(|asset| asset["name"].as_str() == Some(constants::APPIMAGE_ASSET))?;
        let url = asset["browser_download_url"].as_str()?;
        if asset["state"].as_str() != Some("uploaded") || !(url.starts_with(constants::RELEASE_DOWNLOAD_PREFIX) || test_release_url().is_some()) {
            return None;
        }
        Some(Asset {
            url: url.to_string(),
            size: asset["size"].as_u64().filter(|size| *size > 0)?,
            sha256: asset["digest"].as_str()?.strip_prefix("sha256:")?.to_ascii_lowercase(),
        })
    });
    Some(Release { version, asset })
}

fn set_state(state: serde_json::Value) {
    window::post_to_main(serde_json::json!({ "update": state }).to_string());
    *STATE.lock().unwrap() = Some(state);
}

fn check_release() {
    let Some(release) = latest_release() else { return };
    let Ok(current) = semver::Version::parse(env!("CARGO_PKG_VERSION")) else {
        return;
    };
    if release.version <= current {
        return;
    }
    let install = release.asset.as_ref().filter(|_| appimage().is_some());
    debug_print!("updater: {} is out, installable: {}", release.version, install.is_some());
    set_state(serde_json::json!({
        "stage": "offer",
        "version": release.version.to_string(),
        "current": current.to_string(),
        "install": install.is_some(),
        "size": install.map(|asset| asset.size),
    }));
    if let Some(asset) = install {
        *OFFER.lock().unwrap() = Some((release.version, asset.clone()));
    }
}

// page loaded after the check, or asked again
pub fn send_state(browser: &cef::Browser) {
    if let Some(state) = STATE.lock().unwrap().clone() {
        crate::bridge::post_json(browser, &serde_json::json!({ "update": state }).to_string());
    }
}

pub fn install() {
    let Some((version, asset)) = OFFER.lock().unwrap().clone() else { return };
    if READY.load(Ordering::SeqCst) || DOWNLOADING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let version_text = version.to_string();
        match download(&asset, &version_text) {
            Ok(()) => {
                READY.store(true, Ordering::SeqCst);
                set_state(serde_json::json!({ "stage": "ready", "version": version_text }));
            }
            Err(error) => {
                debug_print!("updater: {error}");
                set_state(serde_json::json!({ "stage": "failed", "version": version_text, "error": error }));
            }
        }
        DOWNLOADING.store(false, Ordering::SeqCst);
    });
}

// next to the running AppImage, verified, then renamed over it. the running copy stays mounted from the old inode
fn download(asset: &Asset, version: &str) -> Result<(), String> {
    let target = appimage().ok_or("This copy of Kute is not an AppImage.")?;
    let part = target.with_extension("AppImage.part");
    let result = (|| {
        let response = agent(None).get(&asset.url).call().map_err(|e| format!("The download did not start ({e})."))?;
        let mut body = response.into_body().into_reader();
        let mut file = fs::File::create(&part).map_err(|e| format!("Could not write next to the AppImage ({e})."))?;
        let mut hash = Sha256::new();
        let mut buffer = vec![0u8; 256 * 1024];
        let mut done = 0u64;
        let mut reported = Instant::now();
        loop {
            let read = body.read(&mut buffer).map_err(|e| format!("The download broke off ({e})."))?;
            if read == 0 {
                break;
            }
            done += read as u64;
            if done > asset.size {
                return Err("The download is larger than the release says.".to_string());
            }
            file.write_all(&buffer[..read])
                .map_err(|e| format!("Could not write next to the AppImage ({e})."))?;
            hash.update(&buffer[..read]);
            if reported.elapsed() >= PROGRESS_EVERY {
                reported = Instant::now();
                set_state(serde_json::json!({ "stage": "downloading", "version": version, "done": done, "total": asset.size }));
            }
        }
        file.sync_all().map_err(|e| format!("Could not write next to the AppImage ({e})."))?;
        drop(file);
        if done != asset.size {
            return Err("The download ended early.".to_string());
        }
        let digest: String = hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
        if digest != asset.sha256 {
            return Err("The download is damaged, its checksum does not match the release.".to_string());
        }
        let mode = fs::metadata(&target).map(|meta| meta.permissions().mode()).unwrap_or(0o755) | 0o111;
        fs::set_permissions(&part, fs::Permissions::from_mode(mode)).map_err(|e| format!("Could not make the update executable ({e})."))?;
        fs::rename(&part, &target).map_err(|e| format!("Could not replace the AppImage ({e})."))?;
        debug_print!("updater: {} replaced with {version}", target.display());
        Ok(())
    })();
    if result.is_err() {
        fs::remove_file(&part).ok();
    }
    result
}

// "Restart now" after the AppImage was replaced
pub fn restart() {
    if READY.load(Ordering::SeqCst) {
        crate::modules::lifecycle::restart();
    }
}

pub fn install_pending() {}

pub fn installer_cleanup() -> std::io::Result<()> {
    // a .part a crash left behind
    if let Some(appimage) = appimage() {
        fs::remove_file(appimage.with_extension("AppImage.part")).ok();
    }
    Ok(())
}
