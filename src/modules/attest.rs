use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use sha2::Sha256;

// market session signature, design in _docs/code/host.md (market attestation)

/// hmac(master, version) as hex, set by the release workflow; absent in local builds
const KEY: Option<&str> = option_env!("KUTE_MARKET_KEY");

/// a signature over the challenge, the version and the page's login claim, or null without a key
pub fn attest(challenge: &str, logged_in: bool) -> String {
    let version = env!("CARGO_PKG_VERSION");
    let sig = KEY.filter(|key| !key.is_empty()).and_then(|key| {
        let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).ok()?;
        mac.update(format!("{challenge}|{version}|{}", u8::from(logged_in)).as_bytes());
        Some(STANDARD.encode(mac.finalize().into_bytes()))
    });
    serde_json::json!({
        "marketAttest": {
            "challenge": challenge,
            "sig": sig,
            "version": version,
            "loggedIn": logged_in,
            "keyed": KEY.is_some_and(|key| !key.is_empty()),
        }
    })
    .to_string()
}
