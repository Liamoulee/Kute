// DPAPI (CryptProtectData, user scope) plus the hex the stores keep the blobs as. Only this Windows user on
// this machine can read a blob back, so a copied or synced file is noise. The entropy ties a blob to one use:
// a blob made for the account store does not decrypt as a developer token, and neither decrypts in another
// program that uses DPAPI with the same user
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData};
use windows::core::PCWSTR;

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn unhex(text: &str) -> Option<Vec<u8>> {
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

pub fn protect(text: &str, entropy: &[u8], description: PCWSTR) -> Option<String> {
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &blob(text.as_bytes()),
            description,
            Some(&blob(entropy)),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    }
    .ok()?;
    Some(hex(&take(out)))
}

pub fn unprotect(text: &str, entropy: &[u8]) -> Option<String> {
    let bytes = unhex(text)?;
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe { CryptUnprotectData(&blob(&bytes), None, Some(&blob(entropy)), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }.ok()?;
    String::from_utf8(take(out)).ok()
}
