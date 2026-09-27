use std::{collections::HashSet, fs, io::Write};

use crate::{constants, utils};

#[derive(serde::Deserialize, serde::Serialize)]
struct UserFlags {
    flags: HashSet<String>,
    disabled_defaults: HashSet<String>,
}

pub fn load() -> Vec<String> {
    // "example" is not read, only "flags" and "disabled_defaults" are
    let example_flags: &str = r#"
{
    "flags": [],
    "disabled_defaults": [],
    "example": [
        "--disable-gpu-vsync"
    ]
}"#;

    let defaults: Vec<String> = serde_json::from_str(constants::DEFAULT_FLAGS).unwrap();
    let flaglist_path = utils::settings_dir().join("user_flags.json");
    let mut flaglist_file = if let Ok(flaglist_file) = fs::OpenOptions::new().write(true).read(true).create(true).truncate(false).open(&flaglist_path) {
        flaglist_file
    } else {
        eprintln!("can't open user flags file");
        return defaults;
    };

    if flaglist_file.metadata().unwrap().len() == 0 {
        flaglist_file.write_all(example_flags.as_bytes()).ok();
    }

    let flaglist_string = if let Ok(flaglist_string) = fs::read_to_string(&flaglist_path) {
        flaglist_string
    } else {
        eprintln!("can't read user flags file");
        flaglist_file.set_len(0).ok();
        flaglist_file.write_all(example_flags.as_bytes()).ok();
        return defaults;
    };

    let flaglist = match serde_json::from_str::<UserFlags>(&flaglist_string) {
        Ok(config) if is_old_example(&config) => {
            // the old example put --disable-gpu-vsync into the live list, which broke vsync with uncapFps off
            flaglist_file.set_len(0).ok();
            flaglist_file.write_all(example_flags.as_bytes()).ok();
            return defaults;
        }
        Ok(config) => config,
        Err(_) => {
            flaglist_file.set_len(0).ok();
            flaglist_file.write_all(example_flags.as_bytes()).ok();
            return defaults;
        }
    };

    defaults
        .into_iter()
        .filter(|flag| !flaglist.disabled_defaults.contains(flag))
        .chain(flaglist.flags)
        .collect()
}

// untouched since it was written, a file someone edited differs in some way
fn is_old_example(config: &UserFlags) -> bool {
    config.flags.len() == 1 && config.flags.contains("--disable-gpu-vsync") && config.disabled_defaults.iter().all(|flag| flag.is_empty())
}

pub fn user_flag_names() -> (Vec<String>, Vec<String>) {
    let path = utils::settings_dir().join("user_flags.json");
    let Some(user) = fs::read_to_string(path).ok().and_then(|text| serde_json::from_str::<UserFlags>(&text).ok()) else {
        return (Vec::new(), Vec::new());
    };
    let name = |flag: &String| -> Option<String> {
        let flag = flag.trim();
        if flag.is_empty() {
            return None;
        }
        let keeps_value = flag.starts_with("--enable-features=") || flag.starts_with("--disable-features=");
        let text = if keeps_value { flag } else { flag.split('=').next().unwrap_or(flag) };
        Some(text.chars().take(200).collect())
    };
    (
        user.flags.iter().filter_map(name).take(32).collect(),
        user.disabled_defaults.iter().filter_map(name).take(64).collect(),
    )
}
