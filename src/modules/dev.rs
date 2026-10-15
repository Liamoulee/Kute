use crate::modules::dpapi;
use crate::utils;
use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(windows)]
use windows::Win32::Security::Cryptography::{
    BCRYPT_ALG_HANDLE, BCRYPT_ALG_HANDLE_HMAC_FLAG, BCRYPT_HASH_HANDLE, BCRYPT_SHA256_ALGORITHM, BCryptCloseAlgorithmProvider, BCryptCreateHash,
    BCryptDestroyHash, BCryptFinishHash, BCryptHashData, BCryptOpenAlgorithmProvider,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MessageBoxW};
#[cfg(windows)]
use windows::core::{HSTRING, w};

const ARG: &str = "--set-dev-token=";
const FILE_VERSION: u32 = 1;
// account store blobs don't decrypt here
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

#[cfg(windows)]
fn message(text: &str, error: bool) {
    let style = if error { MB_ICONERROR } else { MB_ICONINFORMATION };
    unsafe { MessageBoxW(None, &HSTRING::from(text), w!("Kute"), MB_OK | style) };
}

// a cli flag, the terminal that ran it reads the answer
#[cfg(target_os = "linux")]
fn message(text: &str, _error: bool) {
    eprintln!("{text}");
}

#[cfg(windows)]
fn protect(text: &str) -> Option<String> {
    dpapi::protect(text, ENTROPY, w!("kute developer"))
}

#[cfg(target_os = "linux")]
fn protect(text: &str) -> Option<String> {
    dpapi::protect(text, ENTROPY, "kute developer")
}

// "--set-dev-token=<username>:<token>" stores, empty value forgets
pub fn handle_cli_flags() -> bool {
    let Some(value) = std::env::args().find_map(|arg| arg.strip_prefix(ARG).map(str::to_string)) else {
        return false;
    };

    if value.is_empty() {
        let gone = fs::remove_file(path()).is_ok();
        message(
            if gone {
                "Developer token removed."
            } else {
                "There was no developer token to remove."
            },
            false,
        );
        return true;
    }

    let (user, token) = value.split_once(':').unwrap_or(("", ""));
    let usable = !user.is_empty() && user.len() <= MAX_USER && (MIN_TOKEN..=MAX_TOKEN).contains(&token.len());
    let stored = usable
        && (|| {
            let store = Store {
                version: FILE_VERSION,
                user: protect(user)?,
                token: protect(token)?,
            };
            let text = serde_json::to_string_pretty(&store).ok()?;
            utils::atomic_write(&path(), &text).ok()
        })()
        .is_some();

    if stored {
        message("Developer token stored. Restart Kute to use it.", false);
    } else {
        message(
            "Could not store the developer token.\n\nExpected --set-dev-token=<username>:<token>, with a token of at least 32 characters.",
            true,
        );
    }
    true
}

pub fn proof(nonce: &str, game: &str, hash: &str) -> Option<(String, String)> {
    let (user, token) = load()?;
    let data = format!("{nonce}\n{game}\n{hash}");
    Some((user, dpapi::hex(&hmac_sha256(token.as_bytes(), data.as_bytes())?)))
}

// rfc 2104
#[cfg(target_os = "linux")]
fn hmac_sha256(key: &[u8], data: &[u8]) -> Option<[u8; 32]> {
    use sha2::{Digest, Sha256};
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| block.map(|k| k ^ byte);
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(data).finalize();
    Some(Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into())
}

#[cfg(windows)]
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

#[cfg(test)]
mod tests {
    #[test]
    fn hmac_matches_rfc_4231() {
        let digest = super::hmac_sha256(b"Jefe", b"what do ya want for nothing?").unwrap();
        assert_eq!(super::dpapi::hex(&digest), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        // key longer than the block gets hashed first (test case 6)
        let digest = super::hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First").unwrap();
        assert_eq!(super::dpapi::hex(&digest), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }
}
