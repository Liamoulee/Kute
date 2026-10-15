// DPAPI stand-in: AES-256-GCM, the key lives in the desktop keyring (secret service), the blobs stay in our json.
// one keyring item for kute, so removing an account leaves nothing behind there
use crate::debug_print;
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, AeadCore, OsRng, Payload},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use zbus::{
    blocking::{Connection, Proxy},
    zvariant::{OwnedObjectPath, OwnedValue, Value},
};

const SERVICE: &str = "org.freedesktop.secrets";
const ATTRIBUTES: [(&str, &str); 2] = [("application", "kute"), ("purpose", "account-key-v1")];
// an unlock prompt waits for the player
const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

// None after a failed lookup is not cached: the keyring may get unlocked later
static KEY: Mutex<Option<[u8; 32]>> = Mutex::new(None);
// a cancelled or unanswered prompt is the player's no until the next start, every page load asks for the list
static DECLINED: AtomicBool = AtomicBool::new(false);

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok()).collect()
}

fn proxy<'a>(connection: &'a Connection, path: &'a str, interface: &'a str) -> zbus::Result<Proxy<'a>> {
    Proxy::new(connection, SERVICE, path, interface)
}

// runs a secret service prompt (unlock, create) and waits for its Completed signal
fn prompt(connection: &Connection, path: &OwnedObjectPath) -> bool {
    if path.as_str() == "/" {
        return true;
    }
    let Ok(prompt) = proxy(connection, path.as_str(), "org.freedesktop.Secret.Prompt") else {
        return false;
    };
    let Ok(mut completed) = prompt.receive_signal("Completed") else {
        return false;
    };
    if prompt.call_method("Prompt", &("",)).is_err() {
        return false;
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let dismissed = completed
            .next()
            .and_then(|message| message.body().deserialize::<(bool, OwnedValue)>().ok())
            .map(|(dismissed, _)| dismissed);
        let _ = sender.send(dismissed);
    });
    let answered = matches!(receiver.recv_timeout(PROMPT_TIMEOUT), Ok(Some(false)));
    if !answered {
        DECLINED.store(true, Ordering::Relaxed);
    }
    answered
}

fn attributes() -> HashMap<&'static str, &'static str> {
    ATTRIBUTES.into_iter().collect()
}

fn load_or_create() -> Option<[u8; 32]> {
    let connection = Connection::session().ok()?;
    let service = proxy(&connection, "/org/freedesktop/secrets", "org.freedesktop.Secret.Service").ok()?;
    let (_, session): (OwnedValue, OwnedObjectPath) = service.call("OpenSession", &("plain", Value::from(""))).ok()?;

    let (mut unlocked, locked): (Vec<OwnedObjectPath>, Vec<OwnedObjectPath>) = service.call("SearchItems", &(attributes(),)).ok()?;
    if unlocked.is_empty() && !locked.is_empty() {
        let (now_unlocked, prompt_path): (Vec<OwnedObjectPath>, OwnedObjectPath) = service.call("Unlock", &(locked.clone(),)).ok()?;
        if !prompt(&connection, &prompt_path) {
            return None;
        }
        unlocked = if now_unlocked.is_empty() { locked } else { now_unlocked };
    }

    if let Some(item) = unlocked.first() {
        let secrets: HashMap<OwnedObjectPath, (OwnedObjectPath, Vec<u8>, Vec<u8>, String)> =
            service.call("GetSecrets", &(vec![item.clone()], &session)).ok()?;
        let (_, _, value, _) = secrets.into_values().next()?;
        return unhex(std::str::from_utf8(&value).ok()?)?.try_into().ok();
    }

    let key: [u8; 32] = Aes256Gcm::generate_key(OsRng).into();
    let collection = proxy(&connection, "/org/freedesktop/secrets/aliases/default", "org.freedesktop.Secret.Collection").ok()?;
    let properties: HashMap<&str, Value> = HashMap::from([
        ("org.freedesktop.Secret.Item.Label", Value::from("Kute account key")),
        ("org.freedesktop.Secret.Item.Attributes", Value::from(attributes())),
    ]);
    let secret = (&session, Vec::<u8>::new(), hex(&key).into_bytes(), "text/plain");
    let (item, prompt_path): (OwnedObjectPath, OwnedObjectPath) = collection.call("CreateItem", &(properties, secret, true)).ok()?;
    // a locked default collection prompts, the item exists once it completed
    if item.as_str() == "/" && !prompt(&connection, &prompt_path) {
        return None;
    }
    Some(key)
}

fn master_key() -> Option<[u8; 32]> {
    let mut cached = KEY.lock().unwrap();
    if cached.is_none() && !DECLINED.load(Ordering::Relaxed) {
        *cached = load_or_create();
        if cached.is_none() {
            debug_print!("dpapi: no secret service key, nothing gets stored");
        }
    }
    *cached
}

// DPAPI's entropy separates the stores (accounts, dev token), here it goes into the key
fn cipher(entropy: &[u8]) -> Option<Aes256Gcm> {
    let mut hasher = Sha256::new();
    hasher.update(master_key()?);
    hasher.update(entropy);
    Aes256Gcm::new_from_slice(&hasher.finalize()).ok()
}

pub fn protect(text: &str, entropy: &[u8], _description: &str) -> Option<String> {
    let cipher = cipher(entropy)?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let sealed = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: text.as_bytes(),
                aad: b"",
            },
        )
        .ok()?;
    Some(hex(&[nonce.as_slice(), &sealed].concat()))
}

pub fn unprotect(text: &str, entropy: &[u8]) -> Option<String> {
    let bytes = unhex(text)?;
    if bytes.len() < 12 {
        return None;
    }
    let (nonce, sealed) = bytes.split_at(12);
    let plain = cipher(entropy)?.decrypt(Nonce::from_slice(nonce), sealed).ok()?;
    String::from_utf8(plain).ok()
}
