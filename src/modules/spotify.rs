// what spotify is playing, read from windows' media session (GSMTC, the volume flyout's source). local only: no account, no network
use crate::{bridge, debug_print};
use base64::Engine;
use std::{
    sync::{
        Mutex,
        atomic::{AtomicI32, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    time::{Duration, Instant},
};
use windows::{
    Foundation::TypedEventHandler,
    Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionMediaProperties as MediaProperties, GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    },
    Storage::Streams::DataReader,
    Win32::System::{
        Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize},
        SystemInformation::GetSystemTimeAsFileTime,
    },
    core::RuntimeType,
};

// spotify's thumbnail is a 300x300 png, about 200 KB
const ARTWORK_MAX_BYTES: u64 = 512 * 1024;
// a song change fires MediaPropertiesChanged twice, the thumbnail can come with the second one
const SETTLE: Duration = Duration::from_millis(150);
// spotify moves the timeline every ~3 s while playing. the page extrapolates, so only a seek is worth a message
const SEEK_MS: i64 = 2000;

#[derive(Clone, Copy)]
enum Signal {
    Session,
    Properties,
    State,
    Resend,
    Stop,
}

static WORKER: Mutex<Option<Sender<Signal>>> = Mutex::new(None);
static BROWSER: AtomicI32 = AtomicI32::new(0);

/// Starts watching Spotify for this browser, or resends the current song to it when already watching.
pub fn start(browser_id: i32) {
    BROWSER.store(browser_id, Ordering::Relaxed);
    let mut worker = WORKER.lock().unwrap();
    // a worker that failed to reach GSMTC has dropped its receiver, so the send fails and a new one starts
    if worker.as_ref().is_some_and(|sender| sender.send(Signal::Resend).is_ok()) {
        return;
    }
    let (sender, receiver) = mpsc::channel();
    *worker = Some(sender.clone());
    std::thread::spawn(move || watch(sender, receiver));
}

/// Stops watching, the event handlers are removed and the thread ends.
pub fn stop() {
    if let Some(sender) = WORKER.lock().unwrap().take() {
        let _ = sender.send(Signal::Stop);
    }
}

struct Song {
    key: String,
    has_artwork: bool,
}

/// What the page was last told, to extrapolate the position the same way it does.
struct Sent {
    playing: bool,
    position: i64,
    duration: i64,
    at: Instant,
}

struct Watch {
    session: Option<(Session, [i64; 3])>,
    song: Option<Song>,
    sent: Option<Sent>,
}

fn watch(sender: Sender<Signal>, receiver: Receiver<Signal>) {
    if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
        debug_print!("spotify: could not initialize com");
        return;
    }
    run(&sender, &receiver);
    unsafe { CoUninitialize() };
}

fn run(sender: &Sender<Signal>, receiver: &Receiver<Signal>) {
    let manager = match Manager::RequestAsync().and_then(|operation| operation.join()) {
        Ok(manager) => manager,
        Err(error) => {
            debug_print!("spotify: no media session manager: {error}");
            return;
        }
    };
    let manager_token = manager.SessionsChanged(&notify(sender, Signal::Session));
    let mut state = Watch {
        session: None,
        song: None,
        sent: None,
    };
    let mut pending = Pending {
        session: true,
        resend: true,
        ..Default::default()
    };
    loop {
        // coalesce a burst of events into one read
        let deadline = Instant::now() + SETTLE;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match receiver.recv_timeout(left) {
                Ok(signal) => pending = pending.add(signal),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => pending.stop = true,
            }
            if pending.stop {
                break;
            }
        }
        if pending.stop {
            break;
        }
        if pending.session {
            attach(&manager, sender, &mut state);
        }
        if pending.resend {
            state.song = None;
            state.sent = None;
        }
        update(&mut state, pending.properties || pending.session || pending.resend);
        pending = Pending::default();
        match receiver.recv() {
            Ok(signal) => pending = pending.add(signal),
            Err(_) => break,
        }
        if pending.stop {
            break;
        }
    }
    detach(&mut state);
    if let Ok(token) = manager_token {
        let _ = manager.RemoveSessionsChanged(token);
    }
    debug_print!("spotify: stopped watching");
}

#[derive(Default)]
struct Pending {
    session: bool,
    properties: bool,
    resend: bool,
    stop: bool,
}

impl Pending {
    fn add(mut self, signal: Signal) -> Self {
        match signal {
            Signal::Session => self.session = true,
            Signal::Properties => self.properties = true,
            Signal::State => {}
            Signal::Resend => self.resend = true,
            Signal::Stop => self.stop = true,
        }
        self
    }
}

fn is_spotify(session: &Session) -> bool {
    // desktop: "Spotify.exe", store: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"
    session
        .SourceAppUserModelId()
        .is_ok_and(|id| id.to_string_lossy().to_ascii_lowercase().contains("spotify"))
}

fn attach(manager: &Manager, sender: &Sender<Signal>, state: &mut Watch) {
    let found = manager.GetSessions().ok().and_then(|sessions| sessions.into_iter().find(is_spotify));
    if found.as_ref() == state.session.as_ref().map(|(session, _)| session) {
        return;
    }
    detach(state);
    let Some(session) = found else {
        debug_print!("spotify: no spotify session");
        return;
    };
    let tokens = [
        session.MediaPropertiesChanged(&notify(sender, Signal::Properties)),
        session.PlaybackInfoChanged(&notify(sender, Signal::State)),
        session.TimelinePropertiesChanged(&notify(sender, Signal::State)),
    ]
    .map(|token| token.unwrap_or(0));
    debug_print!("spotify: watching session");
    state.session = Some((session, tokens));
    state.song = None;
}

// runs on a winrt pool thread, so it only hands the signal to the watcher
fn notify<T: RuntimeType + 'static, A: RuntimeType + 'static>(sender: &Sender<Signal>, signal: Signal) -> TypedEventHandler<T, A> {
    let sender = sender.clone();
    TypedEventHandler::new(move |_, _| {
        let _ = sender.send(signal);
        Ok(())
    })
}

fn detach(state: &mut Watch) {
    if let Some((session, [properties, playback, timeline])) = state.session.take() {
        let _ = session.RemoveMediaPropertiesChanged(properties);
        let _ = session.RemovePlaybackInfoChanged(playback);
        let _ = session.RemoveTimelinePropertiesChanged(timeline);
    }
}

fn post(json: String) {
    bridge::post_json_later(BROWSER.load(Ordering::Relaxed), json);
}

fn update(state: &mut Watch, properties_changed: bool) {
    let Some((session, _)) = state.session.as_ref() else {
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
    let (playing, position, duration) = playback(session);
    if properties_changed || state.song.as_ref().is_some_and(|song| !song.has_artwork) {
        let Some(properties) = session.TryGetMediaPropertiesAsync().and_then(|operation| operation.join()).ok() else {
            return;
        };
        let text = |value: windows::core::Result<windows::core::HSTRING>| value.map(|value| value.to_string_lossy()).unwrap_or_default();
        let (title, artist, album) = (text(properties.Title()), text(properties.Artist()), text(properties.AlbumTitle()));
        let key = format!("{title}\n{artist}\n{album}");
        let known = state.song.as_ref().is_some_and(|song| song.key == key && (song.has_artwork || !properties_changed));
        if !known {
            if title.is_empty() {
                state.song = None;
                state.sent = Some(Sent {
                    playing,
                    position,
                    duration,
                    at: Instant::now(),
                });
                post(r#"{"spotify":null}"#.into());
                return;
            }
            let artwork = artwork(&properties);
            debug_print!("spotify: song {title:?} by {artist:?}, artwork {}", artwork.as_ref().map_or(0, String::len));
            state.song = Some(Song {
                key,
                has_artwork: artwork.is_some(),
            });
            state.sent = Some(Sent {
                playing,
                position,
                duration,
                at: Instant::now(),
            });
            post(
                serde_json::json!({"spotify": {
                    "title": title, "artist": artist, "album": album, "artwork": artwork,
                    "playing": playing, "position": position, "duration": duration,
                }})
                .to_string(),
            );
            return;
        }
    }
    if state.song.is_none() {
        return;
    }
    // timeline events arrive every few seconds while playing, only a play/pause, seek or new length is news
    let unchanged = state.sent.as_ref().is_some_and(|sent| {
        let expected = sent.position + if sent.playing { sent.at.elapsed().as_millis() as i64 } else { 0 };
        sent.playing == playing && sent.duration == duration && (position - expected).abs() < SEEK_MS
    });
    if unchanged {
        return;
    }
    state.sent = Some(Sent {
        playing,
        position,
        duration,
        at: Instant::now(),
    });
    post(serde_json::json!({"spotifyState": {"playing": playing, "position": position, "duration": duration}}).to_string());
}

/// Playing, position now and length, in ms.
fn playback(session: &Session) -> (bool, i64, i64) {
    let playing = session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .is_ok_and(|status| status == PlaybackStatus::Playing);
    let Ok(timeline) = session.GetTimelineProperties() else {
        return (playing, 0, 0);
    };
    let ticks = |value: windows::core::Result<windows::Foundation::TimeSpan>| value.map_or(0, |value| value.Duration);
    let duration = (ticks(timeline.EndTime()) - ticks(timeline.StartTime())).max(0);
    let mut position = ticks(timeline.Position());
    // the position is only as fresh as spotify's last timeline update
    if playing && let Ok(updated) = timeline.LastUpdatedTime() {
        let now = unsafe { GetSystemTimeAsFileTime() };
        let now = ((now.dwHighDateTime as i64) << 32) | now.dwLowDateTime as i64;
        position += (now - updated.UniversalTime).max(0);
    }
    let position = if duration > 0 { position.clamp(0, duration) } else { position.max(0) };
    (playing, position / 10_000, duration / 10_000)
}

fn artwork(properties: &MediaProperties) -> Option<String> {
    let stream = properties.Thumbnail().ok()?.OpenReadAsync().ok()?.join().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > ARTWORK_MAX_BYTES {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
    reader.LoadAsync(size as u32).ok()?.join().ok()?;
    let mut bytes = vec![0; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let content_type = stream.ContentType().map(|value| value.to_string_lossy()).unwrap_or_default();
    let content_type = if content_type.starts_with("image/") {
        content_type
    } else {
        "image/png".into()
    };
    Some(format!(
        "data:{content_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
