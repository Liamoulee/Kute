use serde::{Deserialize, Serialize};
use serde_json::Value;

use std::{
    collections::HashMap,
    env, fs,
    fs::*,
    io::*,
    path::PathBuf,
    sync::{
        LazyLock, Mutex,
        mpsc::{self, Sender},
    },
    time::Duration,
};
#[derive(Deserialize)]
struct SettingInfo {
    #[serde(default)]
    #[serde(rename = "defaultValue")]
    default_value: serde_json::Value,
}

#[derive(Serialize, Deserialize)]
pub struct Config {
    data: HashMap<String, Value>,
}

impl Config {
    pub fn load() -> Config {
        fn load_defaults() -> HashMap<String, Value> {
            let defaults_json = include_str!("./cSettings.json");
            let settings_info: HashMap<String, SettingInfo> = serde_json::from_str(defaults_json).unwrap_or_else(|_| HashMap::new());

            settings_info.iter().map(|(key, info)| (key.clone(), info.default_value.clone())).collect()
        }
        let client_dir: String = env::var("USERPROFILE").unwrap() + "\\Documents\\kute";
        let settings_path: String = client_dir + "\\settings.json";
        let defaults = load_defaults();

        if let Some(parent) = std::path::Path::new(&settings_path).parent() {
            fs::create_dir_all(parent).expect("Failed to create settings directory");
        }

        let mut settings_file = OpenOptions::new().write(true).read(true).create(true).truncate(false).open(&settings_path).unwrap();

        if settings_file.metadata().unwrap().len() == 0 {
            settings_file.write_all(serde_json::to_string_pretty(&defaults).unwrap().as_bytes()).ok();
        }

        let mut settings_string = String::new();
        settings_file.seek(SeekFrom::Start(0)).ok();
        settings_file.read_to_string(&mut settings_string).ok();

        let mut data = match serde_json::from_str(&settings_string) {
            Ok(data) => data,
            Err(e) => {
                println!("Error: {}", e);
                load_defaults()
            }
        };

        for (key, default_value) in defaults {
            data.entry(key).or_insert(default_value);
        }

        Config { data }.migrate_menu_throttle()
    }

    // old inMenuThrottle default 1.5 -> 1. runs once, only touches the old default
    fn migrate_menu_throttle(mut self) -> Config {
        if self.get::<bool>("menuThrottleMigrated").unwrap_or(false) {
            return self;
        }
        self.set("menuThrottleMigrated", true);
        if self.get::<f64>("inMenuThrottle") == Some(1.5) {
            self.set("inMenuThrottle", 1.0);
        }
        self.save();
        self
    }

    pub fn get<T: serde::de::DeserializeOwned>(&self, setting: &str) -> Option<T> {
        self.data.get(setting).and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    pub fn set<T: serde::Serialize>(&mut self, setting: &str, value: T) {
        if let Ok(value) = serde_json::to_value(value) {
            self.data.insert(setting.to_string(), value);
        }
    }

    pub fn save(&self) {
        let Ok(settings_string) = serde_json::to_string_pretty(&self.data) else {
            return;
        };
        write_settings(&settings_string);
    }
}

// delayed save and exit save can race
static WRITE_LOCK: Mutex<()> = Mutex::new(());

// temp file + rename so a crash never leaves half a file
fn write_settings(text: &str) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let settings_path = PathBuf::from(env::var("USERPROFILE").unwrap_or_default()).join("Documents\\kute\\settings.json");
    let temp_path = settings_path.with_extension("json.tmp");
    if fs::write(&temp_path, text).is_ok() {
        fs::rename(&temp_path, &settings_path).ok();
    }
}

static SAVER: LazyLock<Sender<()>> = LazyLock::new(|| {
    let (sender, receiver) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        while receiver.recv().is_ok() {
            while receiver.recv_timeout(Duration::from_secs(1)).is_ok() {}
            let Ok(settings_string) = serde_json::to_string_pretty(&crate::CONFIG.lock().unwrap().data) else {
                continue;
            };
            write_settings(&settings_string);
        }
    });
    sender
});

pub fn save_soon() {
    // bench never writes settings
    if crate::modules::bench::config().is_some() {
        return;
    }
    SAVER.send(()).ok();
}
