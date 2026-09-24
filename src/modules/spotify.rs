use crate::{bridge, debug_print};
use base64::Engine;
use futures_executor::block_on;
use std::{future::IntoFuture, sync::{LazyLock, Mutex}, time::Duration};
use windows::{
    core::HSTRING,
    Media::Control::{GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager, GlobalSystemMediaTransportControlsSessionPlaybackStatus},
    Storage::Streams::DataReader,
    Win32::{
        System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
    },
};

const LOCAL_ARTWORK_MAX_BYTES: u64 = 512 * 1024;

static GENERATION: LazyLock<Mutex<u64>> = LazyLock::new(|| Mutex::new(0));

fn post_error(browser_id: i32, detail: impl Into<String>) {
    let detail = detail.into();
    debug_print!("spotify: ERROR: {detail}");
    bridge::post_json_later(
        browser_id,
        serde_json::json!({"spotifyStatus":"error","spotifyDetail":detail}).to_string(),
    );
}

fn spotify_process_running() -> bool {
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            debug_print!("spotify: could not enumerate processes while checking Spotify.exe");
            return false;
        };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut result = false;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let end = entry.szExeFile.iter().position(|value| *value == 0).unwrap_or(entry.szExeFile.len());
                if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case("Spotify.exe") {
                    result = true;
                    break;
                }
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
        result
    }
}

fn timespan_ms(value: windows::Foundation::TimeSpan) -> u64 {
    value.Duration.max(0) as u64 / 10_000
}

fn read_thumbnail(properties: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Result<Option<String>, String> {
    let thumbnail = match properties.Thumbnail() {
        Ok(thumbnail) => thumbnail,
        Err(_) => return Ok(None),
    };
    let stream = block_on(thumbnail.OpenReadAsync().map_err(|error| format!("could not open GSMTC artwork stream: {error}"))?.into_future())
        .map_err(|error| format!("could not read GSMTC artwork stream: {error}"))?;
    let size = stream.Size().map_err(|error| format!("could not get GSMTC artwork size: {error}"))?;
    if size == 0 || size > LOCAL_ARTWORK_MAX_BYTES {
        debug_print!("spotify: ignoring local artwork with unsupported size {size} bytes");
        return Ok(None);
    }
    let input = stream.GetInputStreamAt(0).map_err(|error| format!("could not open GSMTC artwork input: {error}"))?;
    let reader = DataReader::CreateDataReader(&input)
        .map_err(|error| format!("could not create GSMTC artwork reader: {error}"))?;
    block_on(reader.LoadAsync(size as u32).map_err(|error| format!("could not load GSMTC artwork: {error}"))?.into_future())
        .map_err(|error| format!("could not complete GSMTC artwork read: {error}"))?;
    let mut bytes = vec![0; size as usize];
    reader.ReadBytes(&mut bytes).map_err(|error| format!("could not copy GSMTC artwork bytes: {error}"))?;
    let content_type = stream.ContentType().unwrap_or_else(|_| HSTRING::from("image/jpeg")).to_string_lossy();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(format!("data:{content_type};base64,{encoded}")))
}

fn local_track(session: &GlobalSystemMediaTransportControlsSession) -> Result<serde_json::Value, String> {
    let source = session.SourceAppUserModelId().map_err(|error| format!("could not read GSMTC source app ID: {error}"))?;
    debug_print!("spotify: selected GSMTC session from {}", source.to_string_lossy());
    let playback = session.GetPlaybackInfo().map_err(|error| format!("could not read GSMTC playback info: {error}"))?;
    let status = playback.PlaybackStatus().map_err(|error| format!("could not read GSMTC playback status: {error}"))?;
    let timeline = session.GetTimelineProperties().map_err(|error| format!("could not read GSMTC timeline: {error}"))?;
    let properties = block_on(session.TryGetMediaPropertiesAsync().map_err(|error| format!("could not request GSMTC media properties: {error}"))?.into_future())
        .map_err(|error| format!("could not read GSMTC media properties: {error}"))?;
    let title = properties.Title().map_err(|error| format!("could not read GSMTC title: {error}"))?.to_string_lossy();
    let artist = properties.Artist().map_err(|error| format!("could not read GSMTC artist: {error}"))?.to_string_lossy();
    let album = properties.AlbumTitle().map_err(|error| format!("could not read GSMTC album: {error}"))?.to_string_lossy();
    let artwork = read_thumbnail(&properties)?;
    debug_print!("spotify: local media received title={title:?}, artist={artist:?}, status={status:?}");
    Ok(serde_json::json!({
        "title": title,
        "artist": artist,
        "album": album,
        "artwork": artwork,
        "progress_ms": timespan_ms(timeline.Position().map_err(|error| format!("could not read GSMTC position: {error}"))?),
        "duration_ms": timespan_ms(timeline.EndTime().map_err(|error| format!("could not read GSMTC duration: {error}"))?),
        "is_playing": status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing,
        "playback_status": format!("{status:?}"),
        "source": "windows-gsmtc"
    }))
}

fn find_spotify_session(manager: &GlobalSystemMediaTransportControlsSessionManager) -> Result<Option<GlobalSystemMediaTransportControlsSession>, String> {
    let sessions = manager.GetSessions().map_err(|error| format!("could not enumerate GSMTC sessions: {error}"))?;
    for index in 0..sessions.Size().map_err(|error| format!("could not size GSMTC sessions: {error}"))? {
        let session = sessions.GetAt(index).map_err(|error| format!("could not read GSMTC session {index}: {error}"))?;
        let source = session.SourceAppUserModelId().map_err(|error| format!("could not read GSMTC session source {index}: {error}"))?;
        if source.to_string_lossy().to_ascii_lowercase().contains("spotify") {
            return Ok(Some(session));
        }
    }
    Ok(None)
}

fn local_poll(browser_id: i32, generation: u64) {
    debug_print!("spotify: local GSMTC polling started for browser {browser_id}, generation {generation}");
    let mta = unsafe { windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED) };
    if mta.is_err() {
        post_error(browser_id, format!("could not initialize Windows Media Runtime: {mta:?}"));
        return;
    }
    let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|error| format!("could not request Windows GSMTC manager: {error}"))
        .and_then(|operation| block_on(operation.into_future()).map_err(|error| format!("could not initialize Windows GSMTC manager: {error}")))
    {
        Ok(manager) => manager,
        Err(error) => {
            post_error(browser_id, format!("could not access Windows GSMTC (globalMediaControl): {error}"));
            return;
        }
    };
    let mut last_track = None;
    let mut last_process = None;
    loop {
        if *GENERATION.lock().unwrap() != generation {
            debug_print!("spotify: local GSMTC polling stopped because generation changed");
            return;
        }
        let process_running = spotify_process_running();
        let track = if process_running {
            match find_spotify_session(&manager) {
                Ok(Some(session)) => match local_track(&session) {
                    Ok(track) => Some(track),
                    Err(error) => {
                        debug_print!("spotify: local GSMTC read failed: {error}");
                        None
                    }
                },
                Ok(None) => None,
                Err(error) => {
                    debug_print!("spotify: local GSMTC session enumeration failed: {error}");
                    None
                }
            }
        } else {
            None
        };
        if last_process != Some(process_running) {
            let status = if process_running { "detected" } else { "not-detected" };
            debug_print!("spotify: local process state changed: {status}");
            bridge::post_json_later(
                browser_id,
                serde_json::json!({"spotifyStatus": status, "spotify": if process_running { serde_json::Value::Null } else { serde_json::Value::Null }}).to_string(),
            );
            last_process = Some(process_running);
        }
        if track != last_track {
            debug_print!("spotify: local state changed, process_running={process_running}, track_present={}", track.is_some());
            bridge::post_json_later(browser_id, serde_json::json!({"spotify": track, "spotifyStatus":"local"}).to_string());
            last_track = track;
        }
        std::thread::sleep(Duration::from_millis(750));
    }
}

pub fn status(browser_id: i32) {
    debug_print!("spotify: local status requested by browser {browser_id}");
    let generation = { let mut value = GENERATION.lock().unwrap(); *value += 1; *value };
    std::thread::spawn(move || local_poll(browser_id, generation));
}

pub fn disconnect(browser_id: i32) {
    debug_print!("spotify: disconnect requested by browser {browser_id}");
    *GENERATION.lock().unwrap() += 1;
    bridge::post_json_later(browser_id, r#"{"spotifyStatus":"disconnected","spotify":null}"#.into());
}