use std::{
    collections::HashSet,
    fs,
    io::Write,
    sync::{
        LazyLock,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{constants, utils};

#[derive(serde::Deserialize, serde::Serialize)]
struct UserBlocklist {
    blocked: HashSet<String>,
    disabled_defaults: HashSet<String>,
}

// checked on the IO thread for every request
pub static BLOCKLIST: LazyLock<Vec<String>> = LazyLock::new(|| if utils::config("blocklist", true) { load() } else { Vec::new() });

// "disableOnlineFeatures": the bundle already stays quiet, this also stops an old or broken one
static ONLINE_OFF: LazyLock<AtomicBool> = LazyLock::new(|| AtomicBool::new(utils::config("disableOnlineFeatures", false)));
static API_HOST: LazyLock<String> = LazyLock::new(|| url_host(&utils::api_url()).unwrap_or_default().to_string());

pub fn set_online_off(off: bool) {
    ONLINE_OFF.store(off, Ordering::Relaxed);
}

pub fn is_blocked(url: &str) -> bool {
    (ONLINE_OFF.load(Ordering::Relaxed) && is_kute_server(url)) || BLOCKLIST.iter().any(|pattern| glob_match(pattern, url))
}

fn is_kute_server(url: &str) -> bool {
    url_host(url).is_some_and(|host| host == "kute.lol" || host.ends_with(".kute.lol") || host == API_HOST.as_str())
}

fn url_host(url: &str) -> Option<&str> {
    let (_, rest) = url.split_once("://")?;
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    authority.rsplit('@').next()?.split(':').next()
}

pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut backtrack) = (usize::MAX, 0usize);

    while ti < t.len() {
        if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            backtrack = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            backtrack += 1;
            ti = backtrack;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

pub fn load() -> Vec<String> {
    let example_blocklist: &str = r#"
{
    "blocked": [
        "*://example1.com",
        "*://*.example2.com/*"
    ],
    "disabled_defaults": [
        ""
    ]
}"#;

    let defaults: Vec<String> = serde_json::from_str(constants::DEFAULT_BLOCKLIST).unwrap();
    let blocklist_path = utils::settings_dir().join("user_blocklist.json");
    let mut blocklist_file = if let Ok(file) = fs::OpenOptions::new().write(true).read(true).create(true).truncate(false).open(&blocklist_path) {
        file
    } else {
        eprintln!("can't open blocklist file");
        return defaults;
    };

    if blocklist_file.metadata().unwrap().len() == 0 {
        blocklist_file.write_all(example_blocklist.as_bytes()).ok();
    }

    let blocklist_string = if let Ok(blocklist_string) = fs::read_to_string(&blocklist_path) {
        blocklist_string
    } else {
        eprintln!("can't read user blocklist file");
        blocklist_file.set_len(0).ok();
        blocklist_file.write_all(example_blocklist.as_bytes()).ok();
        return defaults;
    };

    let blocklist = match serde_json::from_str::<UserBlocklist>(&blocklist_string) {
        Ok(config) => config,
        Err(_) => {
            eprintln!("can't parse user blocklist file");
            blocklist_file.set_len(0).ok();
            blocklist_file.write_all(example_blocklist.as_bytes()).ok();
            return defaults;
        }
    };

    defaults
        .into_iter()
        .filter(|url| !blocklist.disabled_defaults.contains(url))
        .chain(blocklist.blocked)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subdomain_wildcard_matches_real_ad_url() {
        assert!(glob_match("*://*.doubleclick.net/*", "https://googleads.g.doubleclick.net/pagead/ads?x=1"));
    }

    #[test]
    fn trailing_star_matches_query_string() {
        assert!(glob_match("*://krunker.io/service-worker.js*", "https://krunker.io/service-worker.js?v=3"));
    }

    #[test]
    fn does_not_match_unrelated_host() {
        assert!(!glob_match("*://*.doubleclick.net/*", "https://krunker.io/js/game.js"));
    }

    #[test]
    fn defaults_never_block_the_game() {
        let defaults: Vec<String> = serde_json::from_str(constants::DEFAULT_BLOCKLIST).unwrap();
        for url in ["https://krunker.io/", "https://krunker.io/js/game.js", "wss://lobby-fra.krunker.io/socket"] {
            assert!(!defaults.iter().any(|p| glob_match(p, url)), "blocked {url}");
        }
    }
}
