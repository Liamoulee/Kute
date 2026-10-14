use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime},
};

use crate::{
    app, bridge, debug_print,
    modules::{eventlog, files, swapper, userscripts, zip},
    utils,
};

// the player sees every entry before saving, and the file holds exactly what was shown (minus what they unticked).
// nothing here runs before the button is pressed

const FORMAT: &str = "kutediag";
const VERSION: u32 = 1;
// the page's part: krunker settings and the auto-detect state
const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_DUMP_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PREVIEW_CHARS: usize = 1024 * 1024;
const MAX_SWAPS_LISTED: usize = 500;

struct Entry {
    name: String,
    kind: &'static str,
    note: String,
    data: Vec<u8>,
}

struct Collected {
    date: (u32, u32, u32),
    entries: Vec<Entry>,
}

static BUSY: AtomicBool = AtomicBool::new(false);
static LAST: Mutex<Option<Collected>> = Mutex::new(None);

fn parse_date(text: &str) -> (u32, u32, u32) {
    let mut parts = text.splitn(3, '-').map(|part| part.parse::<u32>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

fn secs_ago(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    SystemTime::now().duration_since(modified).ok().map(|age| age.as_secs())
}

fn age_note(path: &Path) -> String {
    match secs_ago(path) {
        Some(secs) if secs < 3600 => format!("written {} min ago", secs / 60),
        Some(secs) if secs < 172_800 => format!("written {} h ago", secs / 3600),
        Some(secs) => format!("written {} days ago", secs / 86_400),
        None => String::new(),
    }
}

fn read_tail(path: &Path, max: u64) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return None;
    }
    file.seek(SeekFrom::Start(len.saturating_sub(max))).ok()?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).ok()?;
    Some(data)
}

fn json_file(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or(Value::String(text)),
        Err(_) => Value::Null,
    }
}

fn replace_ignore_case(text: &str, needle: &str, with: &str, whole_word: bool) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    let lower = text.to_ascii_lowercase();
    let needle = needle.to_ascii_lowercase();
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let mut out = String::with_capacity(text.len());
    let mut from = 0;
    while let Some(found) = lower[from..].find(&needle) {
        let start = from + found;
        let end = start + needle.len();
        if whole_word && (word(text[..start].chars().next_back()) || word(text[end..].chars().next())) {
            out.push_str(&text[from..end]);
        } else {
            out.push_str(&text[from..start]);
            out.push_str(with);
        }
        from = end;
    }
    out.push_str(&text[from..]);
    out
}

fn octet(text: &str) -> bool {
    !text.is_empty() && text.len() <= 3 && text.bytes().all(|b| b.is_ascii_digit()) && text.parse::<u32>().is_ok_and(|n| n <= 255)
}

// every dotted quad except loopback and networks (x.y.0.0, which "Chrome/151.0.0.0" also is). a version with a part over 255 is no address
fn redact_ipv4(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    let mut copied = 0;
    while index < bytes.len() {
        let starts_number = bytes[index].is_ascii_digit() && (index == 0 || !(bytes[index - 1].is_ascii_digit() || bytes[index - 1] == b'.'));
        if starts_number {
            let mut end = index;
            while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
                end += 1;
            }
            let candidate = text[index..end].trim_end_matches('.');
            let parts: Vec<&str> = candidate.split('.').collect();
            let network = parts.len() == 4 && parts[2] == "0" && parts[3] == "0";
            if parts.len() == 4 && parts.iter().all(|part| octet(part)) && parts[0] != "127" && !network {
                out.push_str(&text[copied..index]);
                out.push_str("<ip>");
                copied = index + candidate.len();
            }
            index = end;
        } else {
            index += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

const SECRET_PARAMS: [&str; 9] = ["token", "key", "auth", "secret", "password", "passwd", "code", "session", "sig"];

fn redact_query_secrets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(['?', '&']) {
        out.push_str(&rest[..=at]);
        rest = &rest[at + 1..];
        let name_end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(rest.len());
        let name = &rest[..name_end];
        if rest[name_end..].starts_with('=') && SECRET_PARAMS.iter().any(|secret| name.to_ascii_lowercase().contains(secret)) {
            let value_start = name_end + 1;
            let value_end = rest[value_start..]
                .find(|c: char| c == '&' || c == '"' || c == '\\' || c == '\'' || c.is_whitespace())
                .map(|end| value_start + end)
                .unwrap_or(rest.len());
            out.push_str(&rest[..value_start]);
            out.push_str("<redacted>");
            rest = &rest[value_end..];
        }
    }
    out.push_str(rest);
    out
}

struct Identity {
    profile: String,
    user: String,
    computer: String,
}

#[cfg(windows)]
fn identity() -> Identity {
    let var = |name: &str| std::env::var(name).unwrap_or_default();
    Identity {
        profile: var("USERPROFILE"),
        user: var("USERNAME"),
        computer: var("COMPUTERNAME"),
    }
}

#[cfg(target_os = "linux")]
fn identity() -> Identity {
    let var = |name: &str| std::env::var(name).unwrap_or_default();
    Identity {
        profile: var("HOME"),
        user: var("USER"),
        computer: crate::linux::sys::read_trimmed("/proc/sys/kernel/hostname").unwrap_or_default(),
    }
}

fn redact_with(text: &str, who: &Identity) -> String {
    let mut text = text.to_string();
    if who.profile.len() >= 3 {
        let escaped = who.profile.replace('\\', "\\\\");
        let forward = who.profile.replace('\\', "/");
        for variant in [escaped.as_str(), forward.as_str(), who.profile.as_str()] {
            text = replace_ignore_case(&text, variant, "<home>", false);
        }
    }
    // a short name would hit ordinary words
    for (name, with) in [(&who.user, "<user>"), (&who.computer, "<computer>")] {
        if name.len() >= 4 {
            text = replace_ignore_case(&text, name, with, true);
        }
    }
    redact_query_secrets(&redact_ipv4(&text))
}

fn redact(text: &str) -> String {
    redact_with(text, &identity())
}

fn kute_section() -> Value {
    let exe_dir = utils::exe_dir();
    let downloaded_bundle = fs::metadata(exe_dir.join("resources/bundle.js")).map(|meta| meta.len()).unwrap_or(0);
    let libcef = fs::metadata(exe_dir.join(if cfg!(windows) { "libcef.dll" } else { "libcef.so" }))
        .map(|meta| meta.len())
        .ok();
    let mut running: serde_json::Map<String, Value> = app::PATCHES
        .iter()
        .map(|patch| {
            (
                patch.setting.to_string(),
                json!({ "running": app::feature_enabled(patch.feature), "stored": utils::config(patch.setting, patch.default) }),
            )
        })
        .collect();
    running.insert(
        "hardFlip".to_string(),
        json!({ "running": *app::HOOK_AT_START.get().unwrap_or(&true), "stored": utils::config("hardFlip", true) }),
    );
    let cef_version = String::from_utf8_lossy(cef::sys::CEF_VERSION).trim_end_matches('\0').to_string();
    #[cfg(windows)]
    let portable = utils::is_portable();
    #[cfg(target_os = "linux")]
    let portable = std::env::var_os("APPIMAGE").is_none();
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        // 0.0.0 until the updater looked, and in builds without it
        "bundle": { "version": *crate::JS_VERSION.lock().unwrap(), "downloadedBytes": downloaded_bundle },
        "cef": cef_version,
        "libcefBytes": libcef,
        "build": {
            "packaged": cfg!(feature = "packaged"),
            "autoUpdate": cfg!(feature = "auto-update"),
            "verboseLogs": cfg!(feature = "verbose-logs"),
        },
        "portable": portable,
        "uptimeSecs": eventlog::START.elapsed().as_secs(),
        "launchArgs": *crate::LAUNCH_ARGS.lock().unwrap(),
        "hostFeatures": bridge::host_features(),
        "restartOnly": running,
        "frameLimiter": if app::feature_enabled("KuteFrameLimiter") { "viz" } else { "hook" },
    })
}

fn userscripts_section() -> Value {
    userscripts::GROUPS
        .iter()
        .flat_map(|(group, ..)| userscripts::load_group(group))
        .map(|script| {
            let mut crc = flate2::Crc::new();
            crc.update(script.source.as_bytes());
            json!({
                "key": script.key,
                "enabled": script.enabled,
                "runAt": if script.run_at_start { "document-start" } else { "document-end" },
                "bytes": script.size,
                "crc32": format!("{:08x}", crc.sum()),
                "name": script.meta.get("name"),
                "version": script.meta.get("version"),
            })
        })
        .collect()
}

fn config_section() -> Value {
    let dir = utils::settings_dir();
    let settings = serde_json::to_value(&*crate::CONFIG.lock().unwrap())
        .map(|mut config| config["data"].take())
        .unwrap_or(Value::Null);
    let mut swaps = swapper::list();
    let swap_files = swaps["files"].take();
    let swap_count = swap_files.as_array().map(Vec::len).unwrap_or(0);
    let listed: Vec<Value> = swap_files
        .as_array()
        .map(|files| files.iter().take(MAX_SWAPS_LISTED).cloned().collect())
        .unwrap_or_default();
    json!({
        "settings": settings,
        "flags": app::flags(),
        "userFlags": json_file(&dir.join("user_flags.json")),
        "userBlocklist": json_file(&dir.join("user_blocklist.json")),
        "userscripts": userscripts_section(),
        "swapper": { "enabled": swaps["enabled"], "count": swap_count, "files": listed },
        "customCssBytes": fs::metadata(dir.join("custom.css")).map(|meta| meta.len()).unwrap_or(0),
    })
}

#[cfg(windows)]
mod system {
    use serde_json::{Value, json};
    use windows::{
        Win32::{
            Foundation::*,
            Graphics::Dxgi::*,
            System::{Diagnostics::ToolHelp::*, ProcessStatus::*, Registry::*, SystemInformation::*, Threading::*},
        },
        core::*,
    };

    // names only, never the whole process list. each of these has changed how a player's game ran before
    const KNOWN: [(&str, &str); 20] = [
        ("medal", "Medal"),
        ("rtss", "RivaTuner Statistics Server"),
        ("msiafterburner", "MSI Afterburner"),
        ("discord", "Discord"),
        ("obs64", "OBS"),
        ("streamlabs", "Streamlabs"),
        ("nvidia overlay", "NVIDIA overlay"),
        ("nvidia share", "NVIDIA ShadowPlay"),
        ("gamebar", "Xbox Game Bar"),
        ("overwolf", "Overwolf"),
        ("steam", "Steam"),
        ("wallpaper32", "Wallpaper Engine"),
        ("wallpaper64", "Wallpaper Engine"),
        ("lively", "Lively Wallpaper"),
        ("razer", "Razer software"),
        ("lghub", "Logitech G HUB"),
        ("icue", "Corsair iCUE"),
        ("armourycrate", "ASUS Armoury Crate"),
        ("radeonsoftware", "AMD Software"),
        ("processlasso", "Process Lasso"),
    ];

    fn wide(buf: &[u16]) -> String {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..len]).trim().to_string()
    }

    fn reg_string(root: HKEY, path: PCWSTR, name: PCWSTR) -> Option<String> {
        let mut buf = [0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let status = unsafe { RegGetValueW(root, path, name, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut size)) };
        (status == ERROR_SUCCESS).then(|| wide(&buf))
    }

    fn reg_dword(root: HKEY, path: PCWSTR, name: PCWSTR) -> Option<u32> {
        let mut value = 0u32;
        let mut size = 4u32;
        let status = unsafe {
            RegGetValueW(
                root,
                path,
                name,
                RRF_RT_REG_DWORD,
                None,
                Some(&mut value as *mut u32 as *mut _),
                Some(&mut size),
            )
        };
        (status == ERROR_SUCCESS).then_some(value)
    }

    pub fn os() -> Value {
        let nt = w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
        let gpu_prefs = w!("Software\\Microsoft\\DirectX\\UserGpuPreferences");
        let exe = std::env::current_exe().map(|exe| exe.display().to_string()).unwrap_or_default();
        let exe_wide = crate::utils::create_utf_string(&exe);
        json!({
            // says "Windows 10" on 11 too, the build number tells them apart (22000 and up is 11)
            "product": reg_string(HKEY_LOCAL_MACHINE, nt, w!("ProductName")),
            "displayVersion": reg_string(HKEY_LOCAL_MACHINE, nt, w!("DisplayVersion")),
            "build": reg_string(HKEY_LOCAL_MACHINE, nt, w!("CurrentBuildNumber")),
            "ubr": reg_dword(HKEY_LOCAL_MACHINE, nt, w!("UBR")),
            // 2 on, 1 off, missing: driver default
            "hardwareGpuScheduling": reg_dword(HKEY_LOCAL_MACHINE, w!("SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers"), w!("HwSchMode")),
            // 5 turns multiplane overlays off, which takes independent flip away
            "overlayTestMode": reg_dword(HKEY_LOCAL_MACHINE, w!("SOFTWARE\\Microsoft\\Windows\\Dwm"), w!("OverlayTestMode")),
            "gameMode": reg_dword(HKEY_CURRENT_USER, w!("Software\\Microsoft\\GameBar"), w!("AutoGameModeEnabled")),
            "gameDvr": reg_dword(HKEY_CURRENT_USER, w!("System\\GameConfigStore"), w!("GameDVR_Enabled")),
            "directxUserGlobal": reg_string(HKEY_CURRENT_USER, gpu_prefs, w!("DirectXUserGlobalSettings")),
            "kuteGpuPreference": reg_string(HKEY_CURRENT_USER, gpu_prefs, PCWSTR(exe_wide.as_ptr())),
            "uptimeMin": unsafe { GetTickCount64() } / 60_000,
        })
    }

    // the user mode driver version as windows shows it in the device manager, e.g. 32.0.15.6094
    pub fn drivers() -> Value {
        let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
            return Value::Null;
        };
        let mut out = Vec::new();
        let mut index = 0;
        while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
            index += 1;
            let Ok(desc) = (unsafe { adapter.GetDesc1() }) else { continue };
            let version = unsafe { adapter.CheckInterfaceSupport(&IDXGIDevice::IID) }
                .ok()
                .map(|v| format!("{}.{}.{}.{}", (v >> 48) & 0xFFFF, (v >> 32) & 0xFFFF, (v >> 16) & 0xFFFF, v & 0xFFFF));
            out.push(json!({ "name": wide(&desc.Description), "driver": version, "deviceId": desc.DeviceId, "subSysId": desc.SubSysId }));
        }
        out.into()
    }

    pub fn memory() -> Value {
        let mut status = MEMORYSTATUSEX {
            dwLength: size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if unsafe { GlobalMemoryStatusEx(&mut status) }.is_err() {
            return Value::Null;
        }
        let mb = |bytes: u64| bytes / (1024 * 1024);
        json!({
            "totalMb": mb(status.ullTotalPhys),
            "availableMb": mb(status.ullAvailPhys),
            "loadPercent": status.dwMemoryLoad,
            "commitLimitMb": mb(status.ullTotalPageFile),
            "commitAvailableMb": mb(status.ullAvailPageFile),
        })
    }

    fn process_info(pid: u32) -> Value {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return json!({ "pid": pid });
            };
            let mut counters = PROCESS_MEMORY_COUNTERS_EX {
                cb: size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
                ..Default::default()
            };
            let memory = GetProcessMemoryInfo(handle, &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS, counters.cb).is_ok();
            let mut times = [FILETIME::default(); 4];
            let [creation, exit, kernel, user] = &mut times;
            let as_u64 = |t: &FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
            let cpu_ms = GetProcessTimes(handle, creation, exit, kernel, user)
                .is_ok()
                .then(|| (as_u64(kernel) + as_u64(user)) / 10_000);
            CloseHandle(handle).ok();
            json!({
                "pid": pid,
                "workingSetMb": memory.then_some(counters.WorkingSetSize / (1024 * 1024)),
                "privateMb": memory.then_some(counters.PrivateUsage / (1024 * 1024)),
                "cpuMs": cpu_ms,
            })
        }
    }

    // (this process and its children, known overlay and tool names that run)
    pub fn processes() -> (Value, Value) {
        let own = unsafe { GetCurrentProcessId() };
        let mut kute = vec![process_info(own)];
        let mut seen: Vec<&str> = Vec::new();
        unsafe {
            if let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                let mut entry = PROCESSENTRY32W {
                    dwSize: size_of::<PROCESSENTRY32W>() as u32,
                    ..Default::default()
                };
                let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
                while more {
                    if entry.th32ParentProcessID == own {
                        kute.push(process_info(entry.th32ProcessID));
                    }
                    let name = wide(&entry.szExeFile).to_lowercase();
                    for (needle, label) in KNOWN {
                        if name.contains(needle) && !seen.contains(&label) {
                            seen.push(label);
                        }
                    }
                    more = Process32NextW(snapshot, &mut entry).is_ok();
                }
                CloseHandle(snapshot).ok();
            }
        }
        (kute.into(), seen.into())
    }
}

#[cfg(target_os = "linux")]
mod system {
    use crate::linux::sys;
    use serde_json::{Value, json};

    fn kb(key: &str) -> Option<u64> {
        sys::proc_field("/proc/meminfo", key).and_then(|value| value.split_whitespace().next()?.parse::<u64>().ok())
    }

    pub fn os() -> Value {
        json!({
            "kernel": sys::read_trimmed("/proc/sys/kernel/osrelease"),
            "session": std::env::var("XDG_SESSION_TYPE").ok(),
            "desktop": std::env::var("XDG_CURRENT_DESKTOP").ok(),
            "loadavg": sys::read_trimmed("/proc/loadavg"),
        })
    }

    pub fn drivers() -> Value {
        Value::Null
    }

    pub fn memory() -> Value {
        json!({
            "totalMb": kb("MemTotal").map(|kb| kb / 1024),
            "availableMb": kb("MemAvailable").map(|kb| kb / 1024),
            "swapTotalMb": kb("SwapTotal").map(|kb| kb / 1024),
            "swapFreeMb": kb("SwapFree").map(|kb| kb / 1024),
        })
    }

    fn rss_mb(pid: i32) -> Option<u64> {
        sys::proc_field(&format!("/proc/{pid}/status"), "VmRSS")
            .and_then(|value| value.split_whitespace().next()?.parse::<u64>().ok())
            .map(|kb| kb / 1024)
    }

    pub fn processes() -> (Value, Value) {
        let own = std::process::id() as i32;
        let kute: Vec<Value> = std::iter::once(own)
            .chain(sys::child_pids())
            .map(|pid| json!({ "pid": pid, "rssMb": rss_mb(pid) }))
            .collect();
        (kute.into(), Value::Array(Vec::new()))
    }
}

fn live_section(processes: Value) -> Value {
    // rates need two collections, the first one may come back empty
    crate::modules::load::sample();
    std::thread::sleep(Duration::from_millis(500));
    let load = crate::modules::load::sample();
    let present = app::render_stats().map(|(fps, frame_ns)| json!({ "fps": fps, "frameMs": frame_ns as f64 / 1e6 }));
    json!({
        "memory": system::memory(),
        "processes": processes,
        "load": load,
        "hook": app::hook_state(),
        "present": present,
        "gameFpsLimit": utils::config("gameFpsLimit", 0u64),
    })
}

fn system_section(specs: Value) -> Value {
    let (processes, overlays) = system::processes();
    json!({
        "os": system::os(),
        "specs": specs,
        "gpuDrivers": system::drivers(),
        "live": live_section(processes),
        "runningTools": overlays,
    })
}

fn text_entry(name: &str, note: &str, value: &Value) -> Entry {
    Entry {
        name: name.to_string(),
        kind: if name.ends_with(".json") { "json" } else { "text" },
        note: note.to_string(),
        data: redact(&serde_json::to_string_pretty(value).unwrap_or_default()).into_bytes(),
    }
}

fn build(specs: Value, page: Value) -> Collected {
    let date = parse_date(page["date"].as_str().unwrap_or_default());
    let dir = utils::settings_dir();
    let mut entries = vec![
        text_entry(
            "kute.json",
            "Kute version, build and the settings, flags, userscripts and swaps in use",
            &json!({ "kute": kute_section(), "config": config_section() }),
        ),
        text_entry(
            "system.json",
            "Windows, hardware, drivers, memory and processor load right now, tools that are running",
            &system_section(specs),
        ),
        text_entry(
            "krunker.json",
            "Krunker's game settings and what the game page sees",
            &json!({ "settings": page["krunker"], "page": page["page"] }),
        ),
    ];
    if !page["autodetect"].is_null() {
        entries.push(text_entry(
            "autodetect.json",
            "the last Auto-Detect run with its measurements",
            &page["autodetect"],
        ));
    }
    entries.push(text_entry(
        "recovery.json",
        "how the last sessions ended, safe mode and crash test state",
        &crate::modules::recovery::report(),
    ));
    let events = eventlog::lines();
    if !events.is_empty() {
        entries.push(Entry {
            name: "events.txt".to_string(),
            kind: "text",
            note: "recent warnings and errors from Kute and the game page".to_string(),
            data: redact(&events.join("\n")).into_bytes(),
        });
    }
    let crash_log = dir.join("crash_log.txt");
    if let Ok(text) = fs::read_to_string(&crash_log) {
        entries.push(Entry {
            name: "crash_log.txt".to_string(),
            kind: "text",
            note: format!("the last crash, {}", age_note(&crash_log)),
            data: redact(&text).into_bytes(),
        });
    }
    let dump = dir.join("crash.dmp");
    if fs::metadata(&dump).is_ok_and(|meta| meta.len() <= MAX_DUMP_BYTES)
        && let Ok(data) = fs::read(&dump)
    {
        entries.push(Entry {
            name: "crash.dmp".to_string(),
            kind: "binary",
            note: format!(
                "memory snapshot of the last crash, {}. can hold anything Kute had in memory at that moment",
                age_note(&dump)
            ),
            data,
        });
    }
    let cef_log = dir.join("cef_debug.log");
    if let Some(data) = read_tail(&cef_log, MAX_LOG_BYTES) {
        entries.push(Entry {
            name: "cef_debug.log".to_string(),
            kind: "text",
            note: "Chromium's own log (only written by test builds)".to_string(),
            data: redact(&String::from_utf8_lossy(&data)).into_bytes(),
        });
    }
    let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
    let manifest = json!({ "format": FORMAT, "version": VERSION, "kute": env!("CARGO_PKG_VERSION"), "created": page["date"], "entries": names });
    entries.insert(0, text_entry("manifest.json", "what this file is", &manifest));
    Collected { date, entries }
}

fn zipped(collected: &Collected, excluded: &[String]) -> Vec<u8> {
    let entries: Vec<(String, Vec<u8>)> = collected
        .entries
        .iter()
        .filter(|entry| entry.name == "manifest.json" || !excluded.contains(&entry.name))
        .map(|entry| (entry.name.clone(), entry.data.clone()))
        .collect();
    zip::write(&entries, collected.date)
}

fn preview(collected: &Collected) -> Value {
    let entries: Vec<Value> = collected
        .entries
        .iter()
        .map(|entry| {
            let mut value = json!({ "name": entry.name, "kind": entry.kind, "note": entry.note, "bytes": entry.data.len() });
            if entry.kind != "binary" {
                let text = String::from_utf8_lossy(&entry.data);
                match text.char_indices().nth(MAX_PREVIEW_CHARS) {
                    Some((cut, _)) => {
                        value["text"] = json!(&text[..cut]);
                        value["truncated"] = json!(true);
                    }
                    None => value["text"] = json!(text),
                }
            }
            value
        })
        .collect();
    json!({ "entries": entries, "compressed": zipped(collected, &[]).len() })
}

/// collects everything off the ui thread and answers with a preview of each entry
pub fn collect(browser_id: i32, specs: Value, page_json: String) {
    if page_json.len() > MAX_PAGE_BYTES || BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let page: Value = serde_json::from_str(&page_json).unwrap_or(Value::Null);
        let collected = build(specs, page);
        let reply = json!({ "diagnostics": preview(&collected) }).to_string();
        *LAST.lock().unwrap() = Some(collected);
        BUSY.store(false, Ordering::SeqCst);
        bridge::post_json_later(browser_id, reply);
    });
}

/// writes the previewed entries minus the excluded ones into Downloads and shows the file
pub fn save(browser_id: i32, excluded_json: &str) {
    let excluded: Vec<String> = serde_json::from_str(excluded_json).unwrap_or_default();
    std::thread::spawn(move || {
        let reply = match LAST.lock().unwrap().as_ref() {
            Some(collected) => {
                let (year, month, day) = collected.date;
                let target = utils::download_target(&format!("kute-diagnostics-{year:04}-{month:02}-{day:02}.kutediag"));
                let data = zipped(collected, &excluded);
                match fs::write(&target, &data) {
                    Ok(()) => {
                        debug_print!("diagnostics: {} bytes to {}", data.len(), target.display());
                        files::reveal(&target);
                        json!({ "diagnosticsSaved": { "file": target.file_name().map(|name| name.to_string_lossy().into_owned()), "bytes": data.len() } })
                    }
                    Err(error) => json!({ "diagnosticsSaved": { "error": error.to_string() } }),
                }
            }
            None => json!({ "diagnosticsSaved": { "error": "nothing collected" } }),
        };
        bridge::post_json_later(browser_id, reply.to_string());
    });
}

// civil date from days since 1970 (howard hinnant's algorithm), no date crate for one file name
#[cfg(any(windows, test))]
fn today() -> (u32, u32, u32) {
    let days = (SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0) / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year as u32, month as u32, day as u32)
}

/// the recovery dialog before cef starts: no page, so no krunker settings and no auto-detect state
#[cfg(windows)]
pub fn save_without_page() {
    let (year, month, day) = today();
    let page = json!({ "date": format!("{year:04}-{month:02}-{day:02}") });
    let collected = build(crate::modules::specs::collect(Default::default()), page);
    let target = utils::download_target(&format!("kute-diagnostics-{year:04}-{month:02}-{day:02}.kutediag"));
    if fs::write(&target, zipped(&collected, &[])).is_ok() {
        files::reveal(&target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn who() -> Identity {
        Identity {
            profile: "C:\\Users\\Alice".to_string(),
            user: "Alice".to_string(),
            computer: "DESKTOP-ABC123".to_string(),
        }
    }

    #[test]
    fn paths_and_names_go_away() {
        let who = who();
        assert_eq!(redact_with("C:\\Users\\alice\\Documents\\kute", &who), "<home>\\Documents\\kute");
        assert_eq!(redact_with("\"C:\\\\Users\\\\Alice\\\\x\"", &who), "\"<home>\\\\x\"");
        assert_eq!(redact_with("c:/users/alice/x", &who), "<home>/x");
        assert_eq!(redact_with("hi Alice on DESKTOP-ABC123", &who), "hi <user> on <computer>");
        // only whole words, "Alicetown" stays
        assert_eq!(redact_with("Alicetown", &who), "Alicetown");
    }

    #[test]
    fn addresses_but_not_versions() {
        let who = who();
        assert_eq!(redact_with("from 192.168.1.20:443 and 127.0.0.1", &who), "from <ip>:443 and 127.0.0.1");
        assert_eq!(
            redact_with("chromium-151.0.7922.174 driver 32.0.15.6094", &who),
            "chromium-151.0.7922.174 driver 32.0.15.6094"
        );
        assert_eq!(redact_with("1.2.3.4.5", &who), "1.2.3.4.5");
        assert_eq!(redact_with("Chrome/151.0.0.0 Electron", &who), "Chrome/151.0.0.0 Electron");
    }

    #[test]
    fn today_is_a_real_date() {
        let (year, month, day) = today();
        assert!(year >= 2026 && (1..=12).contains(&month) && (1..=31).contains(&day));
    }

    #[test]
    fn url_secrets() {
        let who = who();
        assert_eq!(
            redact_with("https://x.io/a?game=FRA:1&access_token=abc.def&b=2", &who),
            "https://x.io/a?game=FRA:1&access_token=<redacted>&b=2"
        );
        assert_eq!(redact_with("\"https://x.io/?apiKey=123\"", &who), "\"https://x.io/?apiKey=<redacted>\"");
    }
}
