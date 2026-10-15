// what spotify is playing, read over MPRIS on the session bus. same messages as the windows GSMTC reader
use crate::{bridge, debug_print};
use base64::Engine;
use std::{
    collections::HashMap,
    io::Read,
    sync::{
        Mutex,
        atomic::{AtomicI32, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    time::{Duration, Instant},
};
use zbus::{
    blocking::{Connection, Proxy, proxy::Builder},
    proxy::CacheProperties,
    zvariant::OwnedValue,
};

// spotify's thumbnail is a 300x300 png, about 200 KB
const ARTWORK_MAX_BYTES: u64 = 512 * 1024;
// mpris signals no position changes, so it is read on a timer
const POLL: Duration = Duration::from_millis(1000);
// the page extrapolates while playing, only a seek is worth a message
const SEEK_MS: i64 = 2000;
// the desktop client, spotifyd and spotify-player register under these
const BUS_NAMES: [&str; 3] = [
    "org.mpris.MediaPlayer2.spotify",
    "org.mpris.MediaPlayer2.spotifyd",
    "org.mpris.MediaPlayer2.spotify_player",
];
// mpris:artUrl of the desktop client, nothing else is fetched
const ARTWORK_HOST: &str = "https://i.scdn.co/";

enum Signal {
    Resend,
    Stop,
}

static WORKER: Mutex<Option<Sender<Signal>>> = Mutex::new(None);
static BROWSER: AtomicI32 = AtomicI32::new(0);

// Starts watching Spotify for this browser, or resends the current song to it when already watching.
pub fn start(browser_id: i32) {
    BROWSER.store(browser_id, Ordering::Relaxed);
    let mut worker = WORKER.lock().unwrap();
    // a worker without a session bus has dropped its receiver, so the send fails and a new one starts
    if worker.as_ref().is_some_and(|sender| sender.send(Signal::Resend).is_ok()) {
        return;
    }
    let (sender, receiver) = mpsc::channel();
    *worker = Some(sender);
    std::thread::spawn(move || watch(receiver));
}

// Stops watching, the thread ends at its next poll.
pub fn stop() {
    if let Some(sender) = WORKER.lock().unwrap().take() {
        let _ = sender.send(Signal::Stop);
    }
}

struct Song {
    key: String,
    art_url: String,
}

struct Sent {
    playing: bool,
    position: i64,
    duration: i64,
    at: Instant,
}

#[derive(Default)]
struct Watch {
    song: Option<Song>,
    sent: Option<Sent>,
}

struct Playing {
    title: String,
    artist: String,
    album: String,
    art_url: String,
    playing: bool,
    position: i64,
    duration: i64,
}

fn watch(receiver: Receiver<Signal>) {
    let connection = match Connection::session() {
        Ok(connection) => connection,
        Err(_error) => {
            debug_print!("spotify: no session bus: {_error}");
            return;
        }
    };
    let mut state = Watch::default();
    loop {
        update(&connection, &mut state);
        match receiver.recv_timeout(POLL) {
            Ok(Signal::Resend) => state = Watch::default(),
            Ok(Signal::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
    debug_print!("spotify: stopped watching");
}

fn player<'a>(connection: &'a Connection, name: &'a str) -> Option<Proxy<'a>> {
    Builder::new(connection)
        .destination(name)
        .ok()?
        .path("/org/mpris/MediaPlayer2")
        .ok()?
        .interface("org.mpris.MediaPlayer2.Player")
        .ok()?
        .cache_properties(CacheProperties::No)
        .build()
        .ok()
}

fn text(metadata: &HashMap<String, OwnedValue>, key: &str) -> String {
    let Some(value) = metadata.get(key) else { return String::new() };
    if let Ok(text) = String::try_from(value.clone()) {
        return text;
    }
    // xesam:artist is a list
    Vec::<String>::try_from(value.clone()).map(|list| list.join(", ")).unwrap_or_default()
}

fn micros(value: Option<&OwnedValue>) -> i64 {
    let Some(value) = value else { return 0 };
    i64::try_from(value.clone())
        .or_else(|_| u64::try_from(value.clone()).map(|value| value as i64))
        .unwrap_or(0)
}

fn read(connection: &Connection) -> Option<Playing> {
    BUS_NAMES.iter().find_map(|name| {
        let proxy = player(connection, name)?;
        let metadata: HashMap<String, OwnedValue> = proxy.get_property("Metadata").ok()?;
        let playing = proxy.get_property::<String>("PlaybackStatus").is_ok_and(|status| status == "Playing");
        let duration = micros(metadata.get("mpris:length")).max(0) / 1000;
        let position = proxy.get_property::<i64>("Position").unwrap_or(0) / 1000;
        let position = if duration > 0 { position.clamp(0, duration) } else { position.max(0) };
        Some(Playing {
            title: text(&metadata, "xesam:title"),
            artist: text(&metadata, "xesam:artist"),
            album: text(&metadata, "xesam:album"),
            art_url: text(&metadata, "mpris:artUrl"),
            playing,
            position,
            duration,
        })
    })
}

fn post(json: String) {
    bridge::post_json_later(BROWSER.load(Ordering::Relaxed), json);
}

fn update(connection: &Connection, state: &mut Watch) {
    let now = read(connection).filter(|now| !now.title.is_empty());
    let Some(now) = now else {
        if state.song.take().is_some() || state.sent.is_none() {
            state.sent = Some(Sent {
                playing: false,
                position: 0,
                duration: 0,
                at: Instant::now(),
            });
            post(r#"{"spotify":null}"#.into());
        }
        return;
    };
    let key = format!("{}\n{}\n{}", now.title, now.artist, now.album);
    // the art url can arrive a moment after the title
    let known = state.song.as_ref().is_some_and(|song| song.key == key && song.art_url == now.art_url);
    let sent = Sent {
        playing: now.playing,
        position: now.position,
        duration: now.duration,
        at: Instant::now(),
    };
    if !known {
        let artwork = artwork(&now.art_url);
        debug_print!(
            "spotify: song {:?} by {:?}, artwork {}",
            now.title,
            now.artist,
            artwork.as_ref().map_or(0, String::len)
        );
        post(
            serde_json::json!({"spotify": {
                "title": now.title, "artist": now.artist, "album": now.album, "artwork": artwork,
                "playing": now.playing, "position": now.position, "duration": now.duration,
            }})
            .to_string(),
        );
        state.song = Some(Song { key, art_url: now.art_url });
        state.sent = Some(sent);
        return;
    }
    let unchanged = state.sent.as_ref().is_some_and(|last| {
        let expected = last.position + if last.playing { last.at.elapsed().as_millis() as i64 } else { 0 };
        last.playing == now.playing && last.duration == now.duration && (now.position - expected).abs() < SEEK_MS
    });
    if unchanged {
        return;
    }
    post(serde_json::json!({"spotifyState": {"playing": now.playing, "position": now.position, "duration": now.duration}}).to_string());
    state.sent = Some(sent);
}

fn artwork(url: &str) -> Option<String> {
    let bytes = if let Some(path) = url.strip_prefix("file://") {
        let file = std::fs::File::open(path).ok()?;
        let mut bytes = Vec::new();
        file.take(ARTWORK_MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
        bytes
    } else if url.starts_with(ARTWORK_HOST) {
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(5))).build().into();
        let mut bytes = Vec::new();
        agent
            .get(url)
            .call()
            .ok()?
            .into_body()
            .as_reader()
            .take(ARTWORK_MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        bytes
    } else {
        return None;
    };
    if bytes.is_empty() || bytes.len() as u64 > ARTWORK_MAX_BYTES {
        return None;
    }
    let content_type = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else {
        "image/jpeg"
    };
    Some(format!(
        "data:{content_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
