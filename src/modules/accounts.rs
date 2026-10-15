#[cfg(windows)]
use crate::modules::devtools;
use crate::modules::dpapi;
use crate::utils;
#[cfg(windows)]
use cef::Browser;
use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(windows)]
use windows::core::w;

const FILE_VERSION: u32 = 1;
// other programs of the same user can't decrypt our blobs
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

#[derive(Serialize)]
pub struct Public {
    pub username: String,
    pub color: String,
}

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

#[cfg(windows)]
fn protect(text: &str) -> Option<String> {
    dpapi::protect(text, ENTROPY, w!("kute account"))
}

#[cfg(target_os = "linux")]
fn protect(text: &str) -> Option<String> {
    dpapi::protect(text, ENTROPY, "kute account")
}

fn unprotect(text: &str) -> Option<String> {
    dpapi::unprotect(text, ENTROPY)
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

// false on invalid fields, duplicate name or full list
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

// names missing from `order` keep their relative order after the listed ones, so a stale page can't drop an account
pub fn reorder(order: &[String]) {
    let mut accounts: Vec<(Option<usize>, Stored)> = load()
        .into_iter()
        .map(|stored| {
            let rank = unprotect(&stored.username).and_then(|name| order.iter().position(|wanted| *wanted == name));
            (rank, stored)
        })
        .collect();
    accounts.sort_by_key(|(rank, _)| rank.unwrap_or(usize::MAX));
    save(&accounts.into_iter().map(|(_, stored)| stored).collect::<Vec<_>>());
}

// fills and submits krunker's open login form over CDP, page scripts can't see that
#[cfg(windows)]
pub fn login(browser: &Browser, username: &str) {
    if let Some(expression) = login_script(username) {
        devtools::evaluate(browser, &expression);
    }
}

// fills krunker's open login form, run with devtools::evaluate. None when the account is unknown or does not decrypt
pub fn login_script(username: &str) -> Option<String> {
    let stored = load().into_iter().find(|stored| unprotect(&stored.username).as_deref() == Some(username))?;
    let password = unprotect(&stored.password)?;
    // serde string = valid JS string literal
    let (Ok(name), Ok(pass)) = (serde_json::to_string(username), serde_json::to_string(&password)) else {
        return None;
    };
    Some(format!(
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
    ))
}
