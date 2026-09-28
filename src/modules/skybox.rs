use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use cef::{rc::*, *};
use serde_json::Value;

use crate::{debug_print, modules::swapper, utils, utils::config};

// not a real asset: the rewritten map config points the dome at it and texture_for answers it
const TEXTURE_ID: u32 = 9_900_517;
const IMAGE_EXTS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];
const MAP_CONFIG: &str = "https://gapi.svc.krunker.io/maps/";
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(default)]
struct SkyConfig {
    mode: String,
    zenith: String,
    horizon: String,
    image: String,
}

impl Default for SkyConfig {
    fn default() -> Self {
        Self {
            mode: "gradient".to_string(),
            zenith: "#1E5AA8".to_string(),
            horizon: "#9FD0F0".to_string(),
            image: String::new(),
        }
    }
}

pub fn skies_dir() -> PathBuf {
    utils::settings_dir().join("skies")
}

fn enabled() -> bool {
    config("customSky", false)
}

fn sky_config() -> SkyConfig {
    config("customSkyConfig", SkyConfig::default())
}

fn is_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Image files in the skies folder, by name.
pub fn list() -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(skies_dir()) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| image_path(name).is_some())
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    names
}

// a bare file name with an image extension, never a path out of the folder
fn image_path(name: &str) -> Option<PathBuf> {
    let (stem, ext) = name.rsplit_once('.')?;
    let plain = !stem.is_empty() && !name.contains(['/', '\\', ':']) && !name.starts_with('.');
    if !plain || !IMAGE_EXTS.contains(&ext.to_ascii_lowercase().as_str()) {
        return None;
    }
    let path = skies_dir().join(name);
    path.is_file().then_some(path)
}

fn chosen_image(sky: &SkyConfig) -> Option<PathBuf> {
    if sky.mode == "image" { image_path(&sky.image) } else { None }
}

pub fn is_map_config(url: &str) -> bool {
    enabled() && url.strip_prefix(MAP_CONFIG).is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
}

/// The chosen image for the dome's texture requests (base and emissive variant).
pub fn texture_for(url: &str) -> Option<(&'static str, Vec<u8>)> {
    let rest = url.strip_prefix("https://user-assets.krunker.io/")?;
    let (id, file) = rest.split_once('/')?;
    if id.parse::<u32>().ok()? != TEXTURE_ID || !file.starts_with("texture") || !enabled() {
        return None;
    }
    let path = chosen_image(&sky_config())?;
    if std::fs::metadata(&path).ok()?.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    Some((swapper::mime_for(&path.to_string_lossy()), bytes))
}

// sky, fog and friends hold a hex string on some maps and an int on others, keep the map's type
fn color_like(existing: Option<&Value>, hex: &str) -> Value {
    match existing {
        Some(Value::Number(_)) => Value::from(u32::from_str_radix(&hex[1..], 16).unwrap_or(0)),
        _ => Value::from(hex),
    }
}

fn patch_dome(data: &mut serde_json::Map<String, Value>, sky: &SkyConfig) {
    let defaults = SkyConfig::default();
    let zenith = if is_color(&sky.zenith) {
        sky.zenith.as_str()
    } else {
        defaults.zenith.as_str()
    };
    let horizon = if is_color(&sky.horizon) {
        sky.horizon.as_str()
    } else {
        defaults.horizon.as_str()
    };
    let image = chosen_image(sky).is_some();
    // the dome tints its texture by the gradient colors, so they go white under an image
    let (top, bottom) = if image { ("#FFFFFF", "#FFFFFF") } else { (zenith, horizon) };

    data.insert("skyDome".to_string(), Value::Bool(true));
    data.insert("skyDomeTex".to_string(), Value::Bool(image));
    if image {
        data.insert("skyDomeTexA".to_string(), Value::from(TEXTURE_ID));
        // a map's own emissive sky texture would draw over ours
        data.insert("skyDomeEmisTex".to_string(), Value::from(0));
    }
    data.insert("skyDomeCol0".to_string(), Value::from(top));
    data.insert("skyDomeCol1".to_string(), Value::from(bottom));
    data.insert("skyDomeCol2".to_string(), Value::from(bottom));
    // clear color behind the dome
    let clear = color_like(data.get("sky"), bottom);
    data.insert("sky".to_string(), clear);
}

fn rewrite(body: &[u8]) -> Option<Vec<u8>> {
    let mut map: Value = serde_json::from_slice(body).ok()?;
    let sky = sky_config();
    match map.get_mut("data")? {
        Value::Object(data) => patch_dome(data, &sky),
        // tolerated in case a map ships its data as a json string
        Value::String(text) => {
            let mut data: Value = serde_json::from_str(text).ok()?;
            patch_dome(data.as_object_mut()?, &sky);
            *text = data.to_string();
        }
        _ => return None,
    }
    serde_json::to_vec(&map).ok()
}

#[derive(Default)]
struct FilterState {
    input: Vec<u8>,
    output: Option<Vec<u8>>,
    written: usize,
}

wrap_response_filter! {
    struct MapConfigFilter {
        state: Arc<Mutex<FilterState>>,
    }

    impl ResponseFilter {
        fn init_filter(&self) -> ::std::os::raw::c_int {
            1
        }

        // the whole config is buffered, a json edit needs all of it
        fn filter(
            &self,
            data_in: Option<&mut Vec<u8>>,
            data_in_read: Option<&mut usize>,
            data_out: Option<&mut Vec<u8>>,
            data_out_written: Option<&mut usize>,
        ) -> ResponseFilterStatus {
            let mut state = self.state.lock().unwrap();
            if let Some(data_out_written) = data_out_written {
                if let Some(data_in) = data_in {
                    state.input.extend_from_slice(data_in);
                    if let Some(data_in_read) = data_in_read {
                        *data_in_read = data_in.len();
                    }
                    *data_out_written = 0;
                    return ResponseFilterStatus::NEED_MORE_DATA;
                }

                if state.output.is_none() {
                    let input = std::mem::take(&mut state.input);
                    let output = rewrite(&input).unwrap_or_else(|| {
                        debug_print!("skybox: map config not understood, passed through");
                        input
                    });
                    state.output = Some(output);
                }
                let FilterState { output, written, .. } = &mut *state;
                let output = output.as_deref().unwrap_or_default();
                let Some(data_out) = data_out else { return ResponseFilterStatus::ERROR };
                let count = data_out.len().min(output.len() - *written);
                data_out[..count].copy_from_slice(&output[*written..*written + count]);
                *written += count;
                *data_out_written = count;
                if *written < output.len() { ResponseFilterStatus::NEED_MORE_DATA } else { ResponseFilterStatus::DONE }
            } else {
                ResponseFilterStatus::ERROR
            }
        }
    }
}

pub fn filter() -> ResponseFilter {
    MapConfigFilter::new(Arc::new(Mutex::new(FilterState::default())))
}
