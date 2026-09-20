use crate::modules::dpapi;
use crate::utils;
use serde::{Deserialize, Serialize};
use std::fs;
use windows::Win32::Security::Cryptography::{
    BCRYPT_ALG_HANDLE, BCRYPT_ALG_HANDLE_HMAC_FLAG, BCRYPT_HASH_HANDLE, BCRYPT_SHA256_ALGORITHM, BCryptCloseAlgorithmProvider, BCryptCreateHash,
    BCryptDestroyHash, BCryptFinishHash, BCryptHashData, BCryptOpenAlgorithmProvider,
};
use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MessageBoxW};
use windows::core::{PCWSTR, w};

const ARG: &str = "--set-dev-token=";
const FILE_VERSION: u32 = 1;
// ties the blobs to this use, a blob made for the account store does not decrypt here
const ENTROPY: &[u8] = b"kute-dev-v1";
const MAX_USER: usize = 32;
const MIN_TOKEN: usize = 32;
const MAX_TOKEN: usize = 256;

// hex encoded DPAPI blobs
#[derive(Serialize, Deserialize)]
struct Store {
    version: u32,
    user: String,
    token: String,
}

fn path() -> std::path::PathBuf {
    utils::settings_dir().join("dev.json")
}

fn load() -> Option<(String, String)> {
    let text = fs::read_to_string(path()).ok()?;
    let store = serde_json::from_str::<Store>(&text).ok()?;
    if store.version != FILE_VERSION {
        return None;
    }
    Some((dpapi::unprotect(&store.user, ENTROPY)?, dpapi::unprotect(&store.token, ENTROPY)?))
}

pub fn has_token() -> bool {
    path().exists()
}

fn message(text: PCWSTR, style: windows::Win32::UI::WindowsAndMessaging::MESSAGEBOX_STYLE) {
    unsafe { MessageBoxW(None, text, w!("Kute"), MB_OK | style) };
}

// "--set-dev-token=<username>:<token>" stores the pair, "--set-dev-token=" alone forgets it again.
pub fn handle_cli_flags() -> bool {
    let Some(value) = std::env::args().find_map(|arg| arg.strip_prefix(ARG).map(str::to_string)) else {
        return false;
    };

    if value.is_empty() {
        let gone = fs::remove_file(path()).is_ok();
        message(
            if gone {
                w!("Developer token removed.")
            } else {
                w!("There was no developer token to remove.")
            },
            MB_ICONINFORMATION,
        );
        return true;
    }

    let (user, token) = value.split_once(':').unwrap_or(("", ""));
    let usable = !user.is_empty() && user.len() <= MAX_USER && (MIN_TOKEN..=MAX_TOKEN).contains(&token.len());
    let stored = usable
        && (|| {
            let store = Store {
                version: FILE_VERSION,
                user: dpapi::protect(user, ENTROPY, w!("kute developer"))?,
                token: dpapi::protect(token, ENTROPY, w!("kute developer"))?,
            };
            let text = serde_json::to_string_pretty(&store).ok()?;
            utils::atomic_write(&path(), &text).ok()
        })()
        .is_some();

    if stored {
        message(w!("Developer token stored. Restart Kute to use it."), MB_ICONINFORMATION);
    } else {
        message(
            w!("Could not store the developer token.\n\nExpected --set-dev-token=<username>:<token>, with a token of at least 32 characters."),
            MB_ICONERROR,
        );
    }
    true
}

pub fn proof(nonce: &str, game: &str, hash: &str) -> Option<(String, String)> {
    let (user, token) = load()?;
    let data = format!("{nonce}\n{game}\n{hash}");
    Some((user, dpapi::hex(&hmac_sha256(token.as_bytes(), data.as_bytes())?)))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Option<[u8; 32]> {
    let mut algorithm = BCRYPT_ALG_HANDLE::default();
    let mut hash = BCRYPT_HASH_HANDLE::default();
    let mut digest = [0u8; 32];
    unsafe {
        BCryptOpenAlgorithmProvider(&mut algorithm, BCRYPT_SHA256_ALGORITHM, None, BCRYPT_ALG_HANDLE_HMAC_FLAG)
            .ok()
            .ok()?;
        let result = (|| {
            BCryptCreateHash(algorithm, &mut hash, None, Some(key), 0).ok().ok()?;
            BCryptHashData(hash, data, 0).ok().ok()?;
            BCryptFinishHash(hash, &mut digest, 0).ok().ok()
        })();
        if !hash.is_invalid() {
            BCryptDestroyHash(hash).ok().ok();
        }
        BCryptCloseAlgorithmProvider(algorithm, 0).ok().ok();
        result?;
    }
    Some(digest)
}
