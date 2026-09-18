// the account manager's store. credentials live in Documents\kute\accounts.json, each field encrypted with
// DPAPI (CryptProtectData, user scope, extra entropy): only this Windows user on this machine can read them,
// a copied or synced file is noise. the page never holds the list, it gets names and colors, and a login
// is filled into Krunker's form by this process over CDP so the password never crosses the bridge
use crate::modules::devtools;
use crate::utils;
use cef::Browser;
use serde::{Deserialize, Serialize};
use std::fs;
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData};
use windows::core::w;

const FILE_VERSION: u32 = 1;
// ties the blobs to this use, a DPAPI blob made by another program with the same user does not decrypt here
const ENTROPY: &[u8] = b"kute-accounts-v1";
const MAX_ACCOUNTS: usize = 64;
const MAX_FIELD: usize = 256;

#[derive(Serialize, Deserialize, Default)]
struct Store {
    version: u32,
    accounts: Vec<Stored>,
}

// hex encoded DPAPI blobs
#[derive(Serialize, Deserialize, Clone)]
struct Stored {
    username: String,
    password: String,
    color: String,
}

// what the page gets
#[derive(Serialize)]
pub struct Public {
    pub username: String,
    pub color: String,
}

// what the page sends for add and migrate
#[derive(Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub color: String,
}

fn path() -> std::path::PathBuf {
    utils::settings_dir().join("accounts.json")
}

fn load() -> Vec<Stored> {
    let Ok(text) = fs::read_to_string(path()) else { return Vec::new() };
    match serde_json::from_str::<Store>(&text) {
        Ok(store) if store.version == FILE_VERSION => store.accounts,
        _ => Vec::new(),
    }
}

fn save(accounts: &[Stored]) {
    let store = Store {
        version: FILE_VERSION,
        accounts: accounts.to_vec(),
    };
    if let Ok(text) = serde_json::to_string_pretty(&store) {
        utils::atomic_write(&path(), &text).ok();
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok()).collect()
}

fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    }
}

// the bytes of a blob DPAPI allocated, freed afterwards
fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    unsafe { LocalFree(Some(HLOCAL(out.pbData as *mut _))) };
    bytes
}

fn protect(text: &str) -> Option<String> {
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &blob(text.as_bytes()),
            w!("kute account"),
            Some(&blob(ENTROPY)),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    }
    .ok()?;
    Some(hex(&take(out)))
}

fn unprotect(text: &str) -> Option<String> {
    let bytes = unhex(text)?;
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe { CryptUnprotectData(&blob(&bytes), None, Some(&blob(ENTROPY)), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }.ok()?;
    String::from_utf8(take(out)).ok()
}

fn valid(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_FIELD && !text.chars().any(char::is_control)
}

fn color_of(color: &str) -> String {
    let ok = color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit());
    if ok { color.to_string() } else { String::from("#ffffff") }
}

pub fn list() -> Vec<Public> {
    load()
        .iter()
        .filter_map(|stored| {
            Some(Public {
                username: unprotect(&stored.username)?,
                color: stored.color.clone(),
            })
        })
        .collect()
}

// false when nothing was stored: invalid fields, a name that exists already, or the list is full
pub fn add(credentials: &Credentials) -> bool {
    if !valid(&credentials.username) || !valid(&credentials.password) {
        return false;
    }
    let mut accounts = load();
    if accounts.len() >= MAX_ACCOUNTS
        || accounts
            .iter()
            .any(|stored| unprotect(&stored.username).as_deref() == Some(credentials.username.as_str()))
    {
        return false;
    }
    let (Some(username), Some(password)) = (protect(&credentials.username), protect(&credentials.password)) else {
        return false;
    };
    accounts.push(Stored {
        username,
        password,
        color: color_of(&credentials.color),
    });
    save(&accounts);
    true
}

pub fn remove(username: &str) {
    let mut accounts = load();
    accounts.retain(|stored| unprotect(&stored.username).as_deref() != Some(username));
    save(&accounts);
}

// fills Krunker's open login form (the page opened it and switched it to username mode) and submits it.
// evaluated over CDP, which page scripts cannot observe, unlike a bridge message
pub fn login(browser: &Browser, username: &str) {
    let Some(stored) = load().into_iter().find(|stored| unprotect(&stored.username).as_deref() == Some(username)) else {
        return;
    };
    let Some(password) = unprotect(&stored.password) else { return };
    // serde's string encoding is a valid JS string literal
    let (Ok(name), Ok(pass)) = (serde_json::to_string(username), serde_json::to_string(&password)) else {
        return;
    };
    let expression = format!(
        r##"(() => {{
            const name = document.querySelector("#accName");
            const pass = document.querySelector("#accPass");
            if (!name || !pass) return false;
            name.value = {name};
            pass.value = {pass};
            name.dispatchEvent(new Event("input", {{ bubbles: true }}));
            pass.dispatchEvent(new Event("input", {{ bubbles: true }}));
            document.querySelector(".io-button")?.click();
            return true;
        }})()"##
    );
    devtools::evaluate(browser, &expression);
}
