//! Test build only (cargo feature `audio-log`): everything an audio cutout report needs, in one file the tester
//! can send us. Nothing is uploaded, and no normal build contains any of this.
//!
//! The file is `Downloads\kute-audio-log.txt`, rewritten on every start. It holds the machine, the sound devices,
//! the client and the Krunker settings, a line whenever the page's audio changes (`frontend/modules/audioLog.js`
//! posts those), every start of the audio service process, the audio warnings Chromium writes into its own log,
//! and a marker for every F9 the tester presses when they hear a cut.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicU32, Ordering},
    },
    thread,
    time::Duration,
};

use windows::{
    Win32::{
        Foundation::PROPERTYKEY,
        Media::Audio::{DEVICE_STATE_ACTIVE, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, eConsole, eRender},
        System::{
            Com::{
                CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, STGM_READ,
                StructuredStorage::{PropVariantToStringAlloc, PropVariantToUInt32},
            },
            SystemInformation::GetLocalTime,
        },
    },
    core::GUID,
};

use crate::{app, modules::specs, utils};

// PKEY_Device_FriendlyName and PKEY_AudioEndpoint_FormFactor, neither ships with the windows crate
const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};
const PKEY_AUDIO_ENDPOINT_FORM_FACTOR: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x1da5d803_d492_4edd_8c23_e0c0ffee7f0e),
    pid: 0,
};

static MARKS: AtomicU32 = AtomicU32::new(0);
static FILE: Mutex<Option<fs::File>> = Mutex::new(None);

/// The bundle the exe was built with, the same file the updater compares against.
fn bundle_version() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("resources").join("bundle_version")))
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|version| version.trim().to_string())
        .unwrap_or_else(|| "?".to_string())
}

fn log_path() -> PathBuf {
    utils::downloads_dir().join("kute-audio-log.txt")
}

fn stamp() -> String {
    let now = unsafe { GetLocalTime() };
    format!("{:02}:{:02}:{:02}.{:03}", now.wHour, now.wMinute, now.wSecond, now.wMilliseconds)
}

/// Appends one line. Every process that logs keeps its own handle in append mode, so the lines of the browser and
/// of the audio service process land in the same file in the order they happened.
pub fn line(text: &str) {
    let mut handle = FILE.lock().unwrap();
    if handle.is_none() {
        *handle = OpenOptions::new().create(true).append(true).open(log_path()).ok();
    }
    if let Some(file) = handle.as_mut() {
        writeln!(file, "[{}] {}", stamp(), text).ok();
        file.flush().ok();
    }
}

/// One line per entry of a JSON object, so the log stays readable in a text editor.
fn log_json(title: &str, value: &serde_json::Value) {
    line(title);
    match value {
        serde_json::Value::Object(map) => {
            for (key, entry) in map {
                line(&format!("    {key} = {entry}"));
            }
        }
        other => line(&format!("    {other}")),
    }
}

/// The browser process, right after the flags are loaded: rewrites the file and starts the watchers.
pub fn init() {
    fs::remove_file(log_path()).ok();
    *FILE.lock().unwrap() = None;

    let now = unsafe { GetLocalTime() };
    line(&format!(
        "kute audio test build {}, bundle {}, started {:04}-{:02}-{:02}",
        env!("CARGO_PKG_VERSION"),
        bundle_version(),
        now.wYear,
        now.wMonth,
        now.wDay
    ));
    line("press F9 in the client whenever you hear the sound cut, then send this file");
    line("");

    log_json("== machine ==", &specs::collect(Default::default()));
    line("");
    // the config serializes as {"data": {...}}, only the settings themselves are worth a line each
    let settings = serde_json::json!(&*crate::CONFIG.lock().unwrap());
    log_json("== client settings ==", settings.get("data").unwrap_or(&settings));
    line("");

    line("== chromium flags ==");
    for flag in app::flags() {
        line(&format!("    {flag}"));
    }
    line("");

    thread::spawn(|| {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().ok() };
        line("== sound devices ==");
        for device in output_devices() {
            line(&format!("    {device}"));
        }
        line("");
        watch_default_device();
    });
    thread::spawn(tail_cef_log);
}

/// The audio service process (see main.rs), which mixes the game's sound and hands it to Windows. A second
/// "audio service started" line means the service died and Chromium started it again, which is what a cut that
/// comes back on its own would look like from the outside.
pub fn audio_process_start() {
    line(&format!("audio service started, pid {}", std::process::id()));
    thread::spawn(|| {
        loop {
            thread::sleep(Duration::from_secs(15));
            line(&format!("audio service alive, pid {}", std::process::id()));
        }
    });
}

/// F9: the tester heard a cut.
pub fn mark() {
    let number = MARKS.fetch_add(1, Ordering::Relaxed) + 1;
    line("");
    line(&format!("########## MARK {number}: the tester heard a cut here ##########"));
    line("");
}

/// One message from the page ("audio-log <json>", see handlers.rs). `{"section": ..., "data": {...}}` is a block
/// (the Krunker settings, the page's audio setup), anything else is one line of the timeline.
pub fn page(json: &str) {
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(serde_json::Value::Object(map)) => {
            if let Some(title) = map.get("section").and_then(|value| value.as_str()) {
                line("");
                log_json(&format!("== {title} =="), map.get("data").unwrap_or(&serde_json::Value::Null));
                line("");
                return;
            }
            let parts: Vec<String> = map.iter().map(|(key, value)| format!("{key}={value}")).collect();
            line(&format!("page: {}", parts.join(" ")));
        }
        _ => line(&format!("page: {json}")),
    }
}

/// Every active output device with the format Windows mixes it at. A tiny buffer, a Bluetooth headset or a device
/// that comes and goes is a cutout cause of its own.
fn output_devices() -> Vec<String> {
    let mut devices = Vec::new();
    unsafe {
        let Ok(enumerator) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else {
            return devices;
        };
        let default_name = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .ok()
            .map(|device| device_name(&device))
            .unwrap_or_default();
        let Ok(collection) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else {
            return devices;
        };
        for index in 0..collection.GetCount().unwrap_or(0) {
            let Ok(device) = collection.Item(index) else { continue };
            let name = device_name(&device);
            let marker = if !default_name.is_empty() && name == default_name { " (default)" } else { "" };
            devices.push(format!("{name}{marker}{}", device_format(&device)));
        }
    }
    devices
}

fn device_name(device: &IMMDevice) -> String {
    unsafe {
        let Ok(store) = device.OpenPropertyStore(STGM_READ) else {
            return "?".to_string();
        };
        let name = store
            .GetValue(&PKEY_DEVICE_FRIENDLY_NAME)
            .ok()
            .and_then(|value| PropVariantToStringAlloc(&value).ok())
            .map(|text| {
                let string = text.to_string().unwrap_or_default();
                CoTaskMemFree(Some(text.0 as *const _));
                string
            })
            .unwrap_or_else(|| "?".to_string());
        let form = store
            .GetValue(&PKEY_AUDIO_ENDPOINT_FORM_FACTOR)
            .ok()
            .and_then(|value| PropVariantToUInt32(&value).ok())
            .map(form_factor)
            .unwrap_or_default();
        format!("{name}{form}")
    }
}

/// EndpointFormFactor of mmdeviceapi.h, only the ones a player would play through
fn form_factor(value: u32) -> String {
    match value {
        0 => " [speakers]",
        1 => " [line out]",
        2 => " [headphones]",
        3 => " [headset]",
        4 => " [handset]",
        8 => " [spdif]",
        9 => " [hdmi]",
        _ => "",
    }
    .to_string()
}

/// Mix format and buffer period, from the same audio client Chromium opens the device with.
fn device_format(device: &IMMDevice) -> String {
    unsafe {
        let Ok(client) = device.Activate::<IAudioClient>(CLSCTX_ALL, None) else {
            return String::new();
        };
        let mut text = String::new();
        if let Ok(format) = client.GetMixFormat()
            && !format.is_null()
        {
            // WAVEFORMATEX is packed, so the fields get copied out before they are formatted
            let rate = (*format).nSamplesPerSec;
            let channels = (*format).nChannels;
            text.push_str(&format!(", {rate} Hz, {channels} channels"));
            CoTaskMemFree(Some(format as *const _));
        }
        let mut default_period = 0i64;
        let mut minimum_period = 0i64;
        if client.GetDevicePeriod(Some(&mut default_period), Some(&mut minimum_period)).is_ok() {
            // both are in 100 ns units
            text.push_str(&format!(
                ", buffer {:.1} ms (minimum {:.1} ms)",
                default_period as f64 / 10_000.0,
                minimum_period as f64 / 10_000.0
            ));
        }
        text
    }
}

/// Windows switching the default output away and back (a headset falling asleep, a monitor waking up) silences
/// everything for a moment, so the log has to show it.
fn watch_default_device() {
    let mut last = String::new();
    loop {
        let current = unsafe {
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .ok()
                .and_then(|enumerator| enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok())
                .map(|device| device_name(&device))
                .unwrap_or_else(|| "none".to_string())
        };
        if current != last {
            if !last.is_empty() {
                line(&format!("default output device changed: {last} -> {current}"));
            }
            last = current;
        }
        thread::sleep(Duration::from_secs(2));
    }
}

/// Chromium writes its own warnings into cef_debug.log, among them the audio service giving up on the renderer
/// ("SyncReader::Read timed out, audio glitch count="). Those lines get copied over so one file is enough.
fn tail_cef_log() {
    let path = utils::settings_dir().join("cef_debug.log");
    let mut offset = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) as usize;
    loop {
        thread::sleep(Duration::from_secs(2));
        let Ok(text) = fs::read_to_string(&path) else { continue };
        if text.len() < offset {
            // the log was rotated or deleted
            offset = 0;
        }
        let fresh = text[offset..].to_string();
        offset = text.len();
        for entry in fresh.lines().filter(|entry| is_audio_line(entry)).take(50) {
            line(&format!("chromium: {}", entry.trim()));
        }
    }
}

fn is_audio_line(entry: &str) -> bool {
    const WORDS: [&str; 5] = ["udio", "glitch", "SyncReader", "edia", "underrun"];
    WORDS.iter().any(|word| entry.contains(word))
}
