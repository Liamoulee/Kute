use crate::{bridge, debug_print, modules::accounts, utils};
use base64::Engine;
use futures_executor::block_on;
use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{future::IntoFuture, io::{Read, Write}, net::TcpListener, sync::{LazyLock, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use windows::{
    core::{HSTRING, PCWSTR},
    Media::Control::{GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager, GlobalSystemMediaTransportControlsSessionPlaybackStatus},
    Storage::Streams::DataReader,
    Win32::{
        System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
        UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    },
};

const CLIENT_ID_ENV: &str = "KUTE_SPOTIFY_CLIENT_ID";
const REDIRECT_URI: &str = "http://127.0.0.1:43821/callback";
const SCOPES: &str = "user-read-currently-playing user-read-playback-state";
const STORE_VERSION: u32 = 1;
const LOCAL_ARTWORK_MAX_BYTES: u64 = 512 * 1024;

#[derive(Serialize, Deserialize, Clone)]
struct StoredToken {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
}

#[derive(Serialize, Deserialize)]
struct Store {
    version: u32,
    token: Option<StoredToken>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
}

#[derive(Deserialize)]
struct TrackResponse {
    item: Option<TrackItem>,
    progress_ms: Option<u64>,
    is_playing: bool,
}

#[derive(Deserialize)]
struct TrackItem {
    name: String,
    duration_ms: u64,
    artists: Vec<Artist>,
    album: Album,
}

#[derive(Deserialize)]
struct Artist { name: String }

#[derive(Deserialize)]
struct Album {
    name: String,
    images: Vec<Image>,
}

#[derive(Deserialize)]
struct Image { url: String }

static GENERATION: LazyLock<Mutex<u64>> = LazyLock::new(|| Mutex::new(0));

fn path() -> std::path::PathBuf { utils::settings_dir().join("spotify.json") }

fn post_error(browser_id: i32, detail: impl Into<String>) {
    let detail = detail.into();
    debug_print!("spotify: ERROR: {detail}");
    bridge::post_json_later(
        browser_id,
        serde_json::json!({"spotifyStatus":"error","spotifyDetail":detail}).to_string(),
    );
}

fn save(token: Option<&StoredToken>) {
    let stored_token = match token {
        Some(token) => {
            let Some(access_token) = accounts::protect(&token.access_token) else {
                debug_print!("spotify: could not protect access token for storage");
                return;
            };
            let Some(refresh_token) = accounts::protect(&token.refresh_token) else {
                debug_print!("spotify: could not protect refresh token for storage");
                return;
            };
            Some(StoredToken { access_token, refresh_token, expires_at: token.expires_at })
        }
        None => None,
    };
    let store = Store { version: STORE_VERSION, token: stored_token };
    let Ok(text) = serde_json::to_string_pretty(&store) else {
        debug_print!("spotify: could not serialize token store");
        return;
    };
    if let Err(error) = utils::atomic_write(&path(), &text) {
        debug_print!("spotify: could not save token store: {error}");
    }
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |value| value.as_secs()) }

fn client_id() -> Option<String> {
    match std::env::var(CLIENT_ID_ENV).ok().filter(|value| !value.trim().is_empty()) {
        Some(value) => {
            debug_print!("spotify: client ID found ({} characters)", value.len());
            Some(value)
        }
        None => {
            debug_print!("spotify: environment variable {CLIENT_ID_ENV} is missing or empty");
            None
        }
    }
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

fn encode(value: &str) -> String {
    value.bytes().fold(String::new(), |mut result, byte| {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) { result.push(byte as char); }
        else { result.push_str(&format!("%{byte:02X}")); }
        result
    })
}

fn random_verifier() -> String { Alphanumeric.sample_string(&mut rand::rng(), 64) }

fn challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64_url(&digest)
}

fn base64_url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut result = String::new();
    let mut index = 0;
    while index < bytes.len() {
        let first = bytes[index];
        let second = bytes.get(index + 1).copied().unwrap_or(0);
        let third = bytes.get(index + 2).copied().unwrap_or(0);
        result.push(TABLE[(first >> 2) as usize] as char);
        result.push(TABLE[((first & 3) << 4 | second >> 4) as usize] as char);
        if index + 1 < bytes.len() { result.push(TABLE[((second & 15) << 2 | third >> 6) as usize] as char); }
        if index + 2 < bytes.len() { result.push(TABLE[(third & 63) as usize] as char); }
        index += 3;
    }
    result
}

fn open_browser(url: &str) {
    let url = HSTRING::from(url);
    unsafe { ShellExecuteW(None, windows::core::w!("open"), PCWSTR(url.as_ptr()), None, None, SW_SHOWNORMAL); }
}

fn callback(listener: TcpListener) -> Result<String, String> {
    listener.set_nonblocking(false).map_err(|error| format!("could not configure callback listener: {error}"))?;
    let (mut stream, address) = listener.accept().map_err(|error| format!("could not accept Spotify callback: {error}"))?;
    debug_print!("spotify: callback connection accepted from {address}");
    let mut request = [0; 4096];
    let size = stream.read(&mut request).map_err(|error| format!("could not read callback request: {error}"))?;
    let first_line = String::from_utf8_lossy(&request[..size]).lines().next().ok_or("callback request was empty")?.to_string();
    debug_print!("spotify: callback HTTP request received");
    let target = first_line.strip_prefix("GET ").ok_or("callback was not an HTTP GET request")?.split_whitespace().next().ok_or("callback request target was missing")?;
    let query = target.split_once('?').map(|(_, query)| query).ok_or("callback query string was missing")?;
    let parameter = |name: &str| query.split('&').find_map(|part| part.strip_prefix(&format!("{name}=")).map(percent_decode));
    if let Some(error) = parameter("error") {
        return Err(format!("Spotify authorization returned error: {error}"));
    }
    let code = parameter("code").ok_or("Spotify callback did not contain an authorization code")?;
    let response = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nSpotify is connected. You can close this tab.";
    stream.write_all(response).map_err(|error| format!("could not write callback response: {error}"))?;
    Ok(code)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) { result.push(byte); index += 3; continue; }
        }
        result.push(bytes[index]); index += 1;
    }
    String::from_utf8_lossy(&result).into_owned()
}

fn exchange(code: &str, verifier: &str, client_id: &str) -> Result<StoredToken, String> {
    debug_print!("spotify: exchanging authorization code for tokens");
    let response = ureq::post("https://accounts.spotify.com/api/token")
        .send_form([("grant_type", "authorization_code"), ("code", code), ("redirect_uri", REDIRECT_URI), ("client_id", client_id), ("code_verifier", verifier)])
        .map_err(|error| format!("token exchange request failed: {error}"))?;
    let response: TokenResponse = response.into_body().read_json().map_err(|error| format!("token exchange response could not be parsed: {error}"))?;
    let refresh_token = response.refresh_token.ok_or("token exchange response did not include a refresh token")?;
    debug_print!("spotify: token exchange succeeded, expires in {} seconds", response.expires_in);
    Ok(StoredToken { access_token: response.access_token, refresh_token, expires_at: now() + response.expires_in })
}

fn refresh(token: &StoredToken, client_id: &str) -> Result<StoredToken, String> {
    debug_print!("spotify: refreshing access token");
    let response = ureq::post("https://accounts.spotify.com/api/token")
        .send_form([("grant_type", "refresh_token"), ("refresh_token", token.refresh_token.as_str()), ("client_id", client_id)])
        .map_err(|error| format!("token refresh request failed: {error}"))?;
    let response: TokenResponse = response.into_body().read_json().map_err(|error| format!("token refresh response could not be parsed: {error}"))?;
    debug_print!("spotify: token refresh succeeded, expires in {} seconds", response.expires_in);
    Ok(StoredToken { access_token: response.access_token, refresh_token: response.refresh_token.unwrap_or_else(|| token.refresh_token.clone()), expires_at: now() + response.expires_in })
}

fn poll(browser_id: i32, mut token: StoredToken, generation: u64, client_id: String) {
    debug_print!("spotify: playback polling started for browser {browser_id}, generation {generation}");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .build()
        .into();

    loop {
        if *GENERATION.lock().unwrap() != generation {
            debug_print!("spotify: playback polling stopped because generation changed");
            return;
        }

        if token.expires_at <= now() + 30 {
            match refresh(&token, &client_id) {
                Ok(updated) => token = updated,
                Err(error) => {
                    post_error(browser_id, error);
                    return;
                }
            }
            save(Some(&token));
        }

        debug_print!("spotify: requesting currently-playing state");
        let response = agent
            .get("https://api.spotify.com/v1/me/player/currently-playing")
            .header(
                "authorization",
                &format!("Bearer {}", token.access_token),
            )
            .call();

        match response {
            Ok(response) => {
                let status = response.status();
                debug_print!("spotify: currently-playing response status: {status}");
                match status {
                ureq::http::StatusCode::OK => {
                    match response.into_body().read_json::<TrackResponse>() {
                        Ok(current) => {
                            debug_print!("spotify: playback response parsed, track_present={}", current.item.is_some());
                            let track = current.item.map(|item| {
                            serde_json::json!({
                                "title": item.name,
                                "artist": item.artists
                                    .into_iter()
                                    .map(|artist| artist.name)
                                    .collect::<Vec<_>>()
                                    .join(", "),
                                "album": item.album.name,
                                "artwork": item.album.images
                                    .first()
                                    .map(|image| image.url.clone()),
                                "progress_ms": current.progress_ms.unwrap_or(0),
                                "duration_ms": item.duration_ms,
                                "is_playing": current.is_playing
                            })
                        });

                            bridge::post_json_later(
                                browser_id,
                                serde_json::json!({"spotify": track}).to_string(),
                            );
                        }
                        Err(error) => post_error(browser_id, format!("Spotify playback response JSON is invalid: {error}")),
                    }
                }

                ureq::http::StatusCode::NO_CONTENT => {
                    bridge::post_json_later(
                        browser_id,
                        r#"{"spotify":null}"#.into(),
                    );
                }

                ureq::http::StatusCode::UNAUTHORIZED => {
                    debug_print!("spotify: access token rejected with HTTP 401, attempting refresh");
                    match refresh(&token, &client_id) {
                        Ok(updated) => {
                            token = updated;
                            save(Some(&token));
                        }
                        Err(error) => {
                            post_error(browser_id, format!("Spotify returned HTTP 401 and token refresh failed: {error}"));
                            return;
                        }
                    }
                }

                _ => {
                    let body = response.into_body().read_to_string().unwrap_or_else(|error| format!("<could not read error body: {error}>"));
                    post_error(browser_id, format!("Spotify playback API returned HTTP {status}; response body: {body}"));
                }
                }
            }
            Err(error) => post_error(browser_id, format!("Spotify playback request failed: {error}")),
        }

        std::thread::sleep(Duration::from_secs(4));
    }
}

pub fn status(browser_id: i32) {
    debug_print!("spotify: local status requested by browser {browser_id}");
    let generation = { let mut value = GENERATION.lock().unwrap(); *value += 1; *value };
    std::thread::spawn(move || local_poll(browser_id, generation));
}

pub fn connect(browser_id: i32) {
    debug_print!("spotify: manual connection requested by browser {browser_id}");
    let generation = { let mut value = GENERATION.lock().unwrap(); *value += 1; *value };
    std::thread::spawn(move || {
        let Some(client_id) = client_id() else {
            post_error(browser_id, format!("cannot start OAuth: {CLIENT_ID_ENV} is missing or empty"));
            return;
        };
        let listener = match TcpListener::bind("127.0.0.1:43821") {
            Ok(listener) => listener,
            Err(error) => {
                post_error(browser_id, format!("cannot bind OAuth callback listener on 127.0.0.1:43821: {error}"));
                return;
            }
        };
        let verifier = random_verifier();
        let url = format!("https://accounts.spotify.com/authorize?response_type=code&client_id={}&scope={}&redirect_uri={}&code_challenge_method=S256&code_challenge={}", encode(&client_id), encode(SCOPES), encode(REDIRECT_URI), challenge(&verifier));
        debug_print!("spotify: opening authorization browser with redirect URI {REDIRECT_URI} and scopes {SCOPES}");
        open_browser(&url);
        bridge::post_json_later(browser_id, r#"{"spotifyStatus":"waiting"}"#.into());
        let code = match callback(listener) {
            Ok(code) => code,
            Err(error) => {
                post_error(browser_id, error);
                return;
            }
        };
        let token = match exchange(&code, &verifier, &client_id) {
            Ok(token) => token,
            Err(error) => {
                post_error(browser_id, error);
                return;
            }
        };
        save(Some(&token));
        debug_print!("spotify: OAuth connection completed successfully");
        bridge::post_json_later(browser_id, r#"{"spotifyStatus":"connected"}"#.into());
        poll(browser_id, token, generation, client_id);
    });
}

pub fn disconnect(browser_id: i32) {
    debug_print!("spotify: disconnect requested by browser {browser_id}");
    *GENERATION.lock().unwrap() += 1;
    save(None);
    bridge::post_json_later(browser_id, r#"{"spotifyStatus":"disconnected","spotify":null}"#.into());
}