use crate::{
    constants,
    utils::{self, create_utf_string},
};
use cef::{rc::*, *};
use std::{
    cell::{Cell, RefCell},
    env, fs,
    io::{self, Read, Write},
    os::windows::process::CommandExt,
    path::PathBuf,
    process,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};
use windows::{
    Win32::Foundation::*,
    Win32::Security::Cryptography::{BCRYPT_HASH_HANDLE, BCRYPT_SHA256_ALG_HANDLE, BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash, BCryptHashData},
    Win32::System::ApplicationInstallationAndServicing::{ACTCTXW, ActivateActCtx, CreateActCtxW},
    Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW},
    Win32::UI::Controls::*,
    Win32::UI::Shell::ShellExecuteW,
    Win32::UI::WindowsAndMessaging::*,
    core::*,
};

// RT_MANIFEST id in kute-manifest.rc. the process manifest has no comctl32 v6, task dialogs need it
const COMCTL6_MANIFEST: u16 = 100;
// winbase.h, the windows crate keeps them behind another feature
const ACTCTX_FLAG_RESOURCE_NAME_VALID: u32 = 0x8;
const ACTCTX_FLAG_HMODULE_VALID: u32 = 0x80;

const BTN_UPDATE: i32 = 100;
const BTN_PAGE: i32 = 101;
const BTN_RESTART: i32 = 102;

const RUNNING: u8 = 0;
const READY: u8 = 1;
const FAILED: u8 = 2;

struct Pending {
    msi: PathBuf,
    relaunch: bool,
}

// a verified installer, run once the client has shut down
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

#[derive(Clone)]
struct Installer {
    url: String,
    size: u64,
    sha256: Option<String>,
}

struct Release {
    version: semver::Version,
    installer: Option<Installer>,
}

pub fn run() {
    // first, the dialog below can stay open for the whole session
    check_minor_update();
    check_major_update();
}

// dev builds only: a local release json, its downloads may point anywhere
fn test_release_url() -> Option<String> {
    #[cfg(feature = "verbose-logs")]
    return env::var("KUTE_UPDATE_URL").ok();
    #[allow(unreachable_code)]
    None
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
    let response = agent(Some(Duration::from_secs(30))).get(url).call().ok()?;
    let mut text = String::new();
    response.into_body().as_reader().read_to_string(&mut text).ok()?;
    Some(text)
}

fn check_minor_update() {
    let resources = utils::exe_dir().join("resources");
    let current = fs::read_to_string(resources.join("bundle_version")).unwrap_or_else(|_| String::from("0.0.0"));
    *crate::JS_VERSION.lock().unwrap() = current.clone();

    let Some(latest) = get_string(constants::JS_VERSION_URL) else { return };
    let (Ok(parsed_current), Ok(parsed_latest)) = (semver::Version::parse(current.trim()), semver::Version::parse(latest.trim())) else {
        return;
    };
    if parsed_latest <= parsed_current {
        return;
    }
    let Some(bundle) = get_string(constants::JS_BUNDLE_URL) else { return };
    if utils::atomic_write(&resources.join("bundle.js"), &bundle).is_ok() && utils::atomic_write(&resources.join("bundle_version"), &latest).is_ok() {
        *crate::JS_VERSION.lock().unwrap() = latest;
    }
}

// none: this build does not install itself (portable zip), the player gets the release page
fn installer_name() -> Option<&'static str> {
    (cfg!(all(windows, target_arch = "x86_64")) && !utils::is_portable()).then_some(constants::INSTALLER_ASSET)
}

fn latest_release() -> Option<Release> {
    let json = serde_json::from_str::<serde_json::Value>(&get_string(&test_release_url().unwrap_or_else(|| constants::UPDATE_URL.to_string()))?).ok()?;
    let version = semver::Version::parse(json["tag_name"].as_str()?.trim()).ok()?;
    // by exact name, never by position: exes up to 0.1.17 take assets[0] and the api sorts by name
    let installer = installer_name().and_then(|name| {
        let asset = json["assets"].as_array()?.iter().find(|asset| asset["name"].as_str() == Some(name))?;
        let url = asset["browser_download_url"].as_str()?;
        if asset["state"].as_str() != Some("uploaded") || !(url.starts_with(constants::RELEASE_DOWNLOAD_PREFIX) || test_release_url().is_some()) {
            return None;
        }
        Some(Installer {
            url: url.to_string(),
            size: asset["size"].as_u64().filter(|size| *size > 0)?,
            sha256: asset["digest"]
                .as_str()
                .and_then(|digest| digest.strip_prefix("sha256:"))
                .map(str::to_ascii_lowercase),
        })
    });
    Some(Release { version, installer })
}

fn check_major_update() {
    let Some(release) = latest_release() else { return };
    let Ok(current) = semver::Version::parse(env!("CARGO_PKG_VERSION")) else {
        return;
    };
    if release.version <= current {
        return;
    }
    Dialog::show(release, current);
}

struct Sha256(BCRYPT_HASH_HANDLE);

impl Sha256 {
    fn new() -> Option<Self> {
        let mut handle = BCRYPT_HASH_HANDLE::default();
        unsafe { BCryptCreateHash(BCRYPT_SHA256_ALG_HANDLE, &mut handle, None, None, 0) }
            .is_ok()
            .then_some(Self(handle))
    }

    fn update(&mut self, data: &[u8]) -> bool {
        unsafe { BCryptHashData(self.0, data, 0) }.is_ok()
    }

    fn hex(self) -> Option<String> {
        let mut digest = [0u8; 32];
        unsafe { BCryptFinishHash(self.0, &mut digest, 0) }.ok().ok()?;
        Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}

impl Drop for Sha256 {
    fn drop(&mut self) {
        unsafe {
            BCryptDestroyHash(self.0).ok().ok();
        }
    }
}

struct Progress {
    done: AtomicU64,
    total: u64,
    state: AtomicU8,
    cancel: AtomicBool,
    error: Mutex<String>,
}

fn download(installer: &Installer, progress: &Progress) -> std::result::Result<PathBuf, String> {
    let dir = utils::exe_dir();
    let part = dir.join(format!("{}.part", constants::INSTALLER_ASSET));
    // msi registers the file name, and a later run of the github download under another name fails its repair with 1316
    let target = dir.join(constants::INSTALLER_ASSET);

    let result = (|| {
        let response = agent(None).get(&installer.url).call().map_err(|e| format!("The download did not start ({e})."))?;
        let mut body = response.into_body().into_reader();
        let mut file = fs::File::create(&part).map_err(|e| format!("Could not write the installer ({e})."))?;
        let mut hash = Sha256::new().ok_or("Could not check the download.")?;
        let mut buffer = vec![0u8; 256 * 1024];
        let mut done = 0u64;
        loop {
            if progress.cancel.load(Ordering::Relaxed) {
                return Err("Cancelled.".to_string());
            }
            let read = body.read(&mut buffer).map_err(|e| format!("The download broke off ({e})."))?;
            if read == 0 {
                break;
            }
            done += read as u64;
            if done > installer.size {
                return Err("The download is larger than the release says.".to_string());
            }
            file.write_all(&buffer[..read]).map_err(|e| format!("Could not write the installer ({e})."))?;
            if !hash.update(&buffer[..read]) {
                return Err("Could not check the download.".to_string());
            }
            progress.done.store(done, Ordering::Relaxed);
        }
        file.sync_all().map_err(|e| format!("Could not write the installer ({e})."))?;
        drop(file);

        if done != installer.size {
            return Err("The download ended early.".to_string());
        }
        if let Some(expected) = &installer.sha256
            && hash.hex().as_ref() != Some(expected)
        {
            return Err("The download is damaged, its checksum does not match the release.".to_string());
        }
        fs::rename(&part, &target).map_err(|e| format!("Could not write the installer ({e})."))?;
        Ok(target.clone())
    })();

    if result.is_err() {
        fs::remove_file(&part).ok();
    }
    result
}

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Offer,
    Downloading,
    Ready,
    Failed,
}

type TaskDialogIndirect = unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut BOOL) -> HRESULT;

// the activation context stays on for this thread, the dialog's controls are created under it
fn load_task_dialog() -> Option<TaskDialogIndirect> {
    unsafe {
        let module = GetModuleHandleW(None).ok()?;
        let context = ACTCTXW {
            cbSize: size_of::<ACTCTXW>() as u32,
            dwFlags: ACTCTX_FLAG_RESOURCE_NAME_VALID | ACTCTX_FLAG_HMODULE_VALID,
            lpResourceName: PCWSTR(COMCTL6_MANIFEST as usize as *const u16),
            hModule: module,
            ..Default::default()
        };
        let handle = CreateActCtxW(&context).ok()?;
        let mut cookie = 0usize;
        ActivateActCtx(Some(handle), &mut cookie).ok()?;
        let comctl = LoadLibraryW(w!("comctl32.dll")).ok()?;
        let function = GetProcAddress(comctl, s!("TaskDialogIndirect"))?;
        Some(std::mem::transmute::<unsafe extern "system" fn() -> isize, TaskDialogIndirect>(function))
    }
}

fn open_release_page() {
    unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(create_utf_string(constants::RELEASE_PAGE_URL).as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        );
    }
}

wrap_task! {
    struct CloseForUpdate;

    impl Task {
        fn execute(&self) {
            crate::window::close_all();
        }
    }
}

struct Dialog {
    version: String,
    current: String,
    installer: Option<Installer>,
    progress: Arc<Progress>,
    stage: Cell<Stage>,
    shown_mb: Cell<u64>,
    // task dialogs keep pointers to their text, so every string lives as long as the dialog
    strings: RefCell<Vec<Vec<u16>>>,
    buttons: RefCell<Vec<Vec<TASKDIALOG_BUTTON>>>,
}

impl Dialog {
    fn show(release: Release, current: semver::Version) {
        let dialog = Dialog {
            version: release.version.to_string(),
            current: current.to_string(),
            progress: Arc::new(Progress {
                done: AtomicU64::new(0),
                total: release.installer.as_ref().map_or(0, |installer| installer.size),
                state: AtomicU8::new(RUNNING),
                cancel: AtomicBool::new(false),
                error: Mutex::new(String::new()),
            }),
            installer: release.installer,
            stage: Cell::new(Stage::Offer),
            shown_mb: Cell::new(u64::MAX),
            strings: RefCell::new(Vec::new()),
            buttons: RefCell::new(Vec::new()),
        };

        let Some(task_dialog) = load_task_dialog() else {
            let text = create_utf_string(format!("Kute {} is available. Open the download page?", dialog.version));
            if unsafe { MessageBoxW(None, PCWSTR(text.as_ptr()), w!("Kute update"), MB_ICONQUESTION | MB_YESNO) } == IDYES {
                open_release_page();
            }
            return;
        };
        let config = dialog.config(Stage::Offer);
        unsafe {
            task_dialog(&config, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()).ok().ok();
        }
    }

    fn text(&self, text: impl AsRef<str>) -> PCWSTR {
        let wide = create_utf_string(text);
        let pointer = PCWSTR(wide.as_ptr());
        self.strings.borrow_mut().push(wide);
        pointer
    }

    fn config(&self, stage: Stage) -> TASKDIALOGCONFIG {
        let mut flags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_CAN_BE_MINIMIZED | TDF_CALLBACK_TIMER | TDF_ENABLE_HYPERLINKS;
        let mut common = TASKDIALOG_COMMON_BUTTON_FLAGS(0);
        let (main, content, buttons, default): (String, String, Vec<(i32, &str)>, i32) = match stage {
            Stage::Offer if self.installer.is_some() => (
                format!("Kute {} is available", self.version),
                format!(
                    "You have {}. The update downloads in the background while you play, Kute only restarts when you say so.",
                    self.current
                ),
                vec![(BTN_UPDATE, "Update"), (IDCANCEL.0, "Not now")],
                BTN_UPDATE,
            ),
            Stage::Offer => (
                format!("Kute {} is available", self.version),
                if utils::is_portable() {
                    format!(
                        "You have {}. This is the portable version: download the new zip and replace this folder with it.",
                        self.current
                    )
                } else {
                    format!("You have {}. Download it from the release page.", self.current)
                },
                vec![(BTN_PAGE, "Open download page"), (IDCANCEL.0, "Not now")],
                BTN_PAGE,
            ),
            Stage::Downloading => {
                flags |= TDF_SHOW_PROGRESS_BAR;
                (
                    format!("Downloading Kute {}", self.version),
                    "Starting the download. You can keep playing.".to_string(),
                    vec![(IDCANCEL.0, "Cancel")],
                    IDCANCEL.0,
                )
            }
            Stage::Ready => (
                format!("Kute {} is ready", self.version),
                "Restart Kute to finish the update. In a match? Choose Later, the update installs when you close Kute.".to_string(),
                vec![(BTN_RESTART, "Restart now"), (IDCANCEL.0, "Later")],
                BTN_RESTART,
            ),
            Stage::Failed => {
                common = TDCBF_CLOSE_BUTTON;
                (
                    "The update could not be downloaded".to_string(),
                    format!("{} Kute will ask again on the next start.", self.progress.error.lock().unwrap()),
                    Vec::new(),
                    IDCLOSE.0,
                )
            }
        };

        let buttons: Vec<TASKDIALOG_BUTTON> = buttons
            .into_iter()
            .map(|(id, label)| TASKDIALOG_BUTTON {
                nButtonID: id,
                pszButtonText: self.text(label),
            })
            .collect();
        let config = TASKDIALOGCONFIG {
            cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
            dwFlags: flags,
            dwCommonButtons: common,
            pszWindowTitle: self.text("Kute update"),
            pszMainInstruction: self.text(main),
            pszContent: self.text(content),
            cButtons: buttons.len() as u32,
            pButtons: buttons.as_ptr(),
            nDefaultButton: default,
            pszFooter: self.text(format!("<a href=\"notes\">What's new in {}</a>", self.version)),
            pfCallback: Some(callback),
            lpCallbackData: self as *const Dialog as isize,
            ..Default::default()
        };
        self.buttons.borrow_mut().push(buttons);
        config
    }

    fn navigate(&self, hwnd: HWND, stage: Stage) {
        self.stage.set(stage);
        let config = self.config(stage);
        unsafe {
            SendMessageW(hwnd, TDM_NAVIGATE_PAGE.0 as u32, None, Some(LPARAM(&config as *const _ as isize)));
        }
    }

    fn on_page(&self, hwnd: HWND) {
        if self.stage.get() == Stage::Downloading {
            unsafe {
                SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_RANGE.0 as u32, None, Some(LPARAM((1000 << 16) as isize)));
            }
        }
    }

    fn tick(&self, hwnd: HWND) {
        if self.stage.get() != Stage::Downloading {
            return;
        }
        match self.progress.state.load(Ordering::Acquire) {
            READY => {
                self.navigate(hwnd, Stage::Ready);
                unsafe {
                    FlashWindowEx(&FLASHWINFO {
                        cbSize: size_of::<FLASHWINFO>() as u32,
                        hwnd,
                        dwFlags: FLASHW_TRAY | FLASHW_TIMERNOFG,
                        ..Default::default()
                    })
                    .ok()
                    .ok();
                }
            }
            FAILED => self.navigate(hwnd, Stage::Failed),
            _ => {
                let (done, total) = (self.progress.done.load(Ordering::Relaxed), self.progress.total.max(1));
                let mb = done / 1_000_000;
                if mb == self.shown_mb.get() {
                    return;
                }
                self.shown_mb.set(mb);
                let text = self.text(format!("{mb} of {} MB. You can keep playing.", total.div_ceil(1_000_000)));
                unsafe {
                    SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_POS.0 as u32, Some(WPARAM((done * 1000 / total) as usize)), None);
                    SendMessageW(
                        hwnd,
                        TDM_SET_ELEMENT_TEXT.0 as u32,
                        Some(WPARAM(TDE_CONTENT.0 as usize)),
                        Some(LPARAM(text.0 as isize)),
                    );
                }
            }
        }
    }

    // S_FALSE keeps the dialog open
    fn clicked(&self, hwnd: HWND, id: i32) -> HRESULT {
        match (self.stage.get(), id) {
            (Stage::Offer, BTN_UPDATE) => {
                let (Some(installer), progress) = (self.installer.clone(), self.progress.clone()) else {
                    return S_OK;
                };
                std::thread::spawn(move || match download(&installer, &progress) {
                    Ok(msi) if progress.cancel.load(Ordering::Relaxed) => {
                        fs::remove_file(msi).ok();
                    }
                    Ok(msi) => {
                        *PENDING.lock().unwrap() = Some(Pending { msi, relaunch: false });
                        progress.state.store(READY, Ordering::Release);
                    }
                    Err(error) => {
                        *progress.error.lock().unwrap() = error;
                        progress.state.store(FAILED, Ordering::Release);
                    }
                });
                self.navigate(hwnd, Stage::Downloading);
                S_FALSE
            }
            (Stage::Offer, BTN_PAGE) => {
                open_release_page();
                S_OK
            }
            (Stage::Downloading, _) => {
                self.progress.cancel.store(true, Ordering::Relaxed);
                PENDING.lock().unwrap().take();
                S_OK
            }
            (Stage::Ready, BTN_RESTART) => {
                if let Some(pending) = PENDING.lock().unwrap().as_mut() {
                    pending.relaunch = true;
                }
                let mut task = CloseForUpdate::new();
                post_task(ThreadId::UI, Some(&mut task));
                S_OK
            }
            _ => S_OK,
        }
    }
}

unsafe extern "system" fn callback(hwnd: HWND, msg: TASKDIALOG_NOTIFICATIONS, wparam: WPARAM, _lparam: LPARAM, data: isize) -> HRESULT {
    let dialog = unsafe { &*(data as *const Dialog) };
    match msg {
        TDN_CREATED => {
            set_icons(hwnd);
            // the main window comes up around the same time and would cover the offer
            unsafe {
                SetForegroundWindow(hwnd).ok().ok();
            }
            dialog.on_page(hwnd);
        }
        TDN_NAVIGATED => dialog.on_page(hwnd),
        TDN_TIMER => dialog.tick(hwnd),
        TDN_HYPERLINK_CLICKED => open_release_page(),
        TDN_BUTTON_CLICKED => return dialog.clicked(hwnd, wparam.0 as i32),
        _ => {}
    }
    S_OK
}

fn set_icons(hwnd: HWND) {
    unsafe {
        let Ok(module) = GetModuleHandleW(None) else { return };
        for (kind, width, height) in [(ICON_SMALL, SM_CXSMICON, SM_CYSMICON), (ICON_BIG, SM_CXICON, SM_CYICON)] {
            let (width, height) = (GetSystemMetrics(width), GetSystemMetrics(height));
            if let Ok(icon) = LoadImageW(Some(module.into()), w!("icon"), IMAGE_ICON, width, height, LR_SHARED) {
                SendMessageW(hwnd, WM_SETICON, Some(WPARAM(kind as usize)), Some(LPARAM(icon.0 as isize)));
            }
        }
    }
}

// after shutdown: the client no longer holds its files, msiexec closes nothing of ours
pub fn install_pending() {
    let Some(pending) = PENDING.lock().unwrap().take() else { return };
    let msiexec = PathBuf::from(env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string()))
        .join("System32")
        .join("msiexec.exe");
    let mut command = process::Command::new(msiexec);
    // basic ui without cancel or a final dialog, so the player sees it install
    command.raw_arg(format!("/i \"{}\" /qb!-", pending.msi.display()));
    if !pending.relaunch {
        command.raw_arg("KUTE_NO_LAUNCH=1");
    }
    command.spawn().ok();
}

pub fn installer_cleanup() -> io::Result<()> {
    // a portable folder may be the downloads folder, its msi files are not ours
    if utils::is_portable() {
        return Ok(());
    }
    for entry in fs::read_dir(utils::exe_dir())? {
        let path = entry?.path();
        let name = path.file_name().map(|name| name.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        if path.is_file() && (name.ends_with(".msi") || name.ends_with(".msi.part")) {
            fs::remove_file(&path).ok();
        }
    }
    Ok(())
}
