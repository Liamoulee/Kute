use super::{gpu, nvidia, sys};
use std::{fs, sync::Mutex};

// (busy, total) jiffies of the last call
static LAST: Mutex<Option<(u64, u64)>> = Mutex::new(None);

fn cpu_jiffies() -> Option<(u64, u64)> {
    let stat = fs::read_to_string("/proc/stat").ok()?;
    let fields: Vec<u64> = stat.lines().next()?.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    let total: u64 = fields.iter().take(8).sum();
    // idle and iowait
    let idle = fields.get(3)? + fields.get(4).unwrap_or(&0);
    Some((total - idle, total))
}

fn round(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn khz(path: impl AsRef<std::path::Path>) -> Option<f64> {
    sys::read_trimmed(path)?.parse().ok()
}

// percent of the rated clock like windows' "% Processor Performance": above 100 with turbo, far below while throttled.
// a moment, not an average over the reading. base_frequency is intel_pstate's, other drivers only have the maximum
fn cpu_speed() -> Option<f64> {
    let (mut sum, mut count) = (0.0, 0);
    for entry in fs::read_dir("/sys/devices/system/cpu/cpufreq").ok()?.flatten() {
        let policy = entry.path();
        let (Some(now), Some(rated)) = (
            khz(policy.join("scaling_cur_freq")),
            khz(policy.join("base_frequency")).or_else(|| khz(policy.join("cpuinfo_max_freq"))),
        ) else {
            continue;
        };
        if rated > 0.0 {
            sum += now / rated;
            count += 1;
        }
    }
    (count > 0).then(|| round(sum * 100.0 / count as f64))
}

// the processor's own sensors (package and cores), else the acpi zones windows reads
fn temperature() -> Option<f64> {
    let hottest = |paths: Vec<std::path::PathBuf>| {
        paths
            .into_iter()
            .filter_map(|path| sys::read_trimmed(path)?.parse::<f64>().ok())
            .map(|millis| millis / 1000.0)
            .reduce(f64::max)
    };
    let mut sensors = Vec::new();
    for hwmon in fs::read_dir("/sys/class/hwmon").ok()?.flatten() {
        let path = hwmon.path();
        if matches!(sys::read_trimmed(path.join("name")).as_deref(), Some("coretemp" | "k10temp" | "zenpower")) {
            sensors.extend(fs::read_dir(&path).ok()?.flatten().map(|entry| entry.path()).filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("temp") && name.ends_with("_input"))
            }));
        }
    }
    hottest(sensors)
        .or_else(|| {
            let zones = fs::read_dir("/sys/class/thermal").ok()?.flatten().map(|zone| zone.path().join("temp")).collect();
            hottest(zones)
        })
        .map(round)
}

// per gpu, keyed like specs' luid. copy engines have no counter here
fn gpu_load() -> serde_json::Map<String, serde_json::Value> {
    gpu::cards()
        .iter()
        .filter_map(|card| {
            let busy = match card.driver.as_str() {
                "nvidia" => nvidia::busy(&card.pci),
                _ => sys::read_trimmed(card.device.join("gpu_busy_percent")).and_then(|percent| percent.parse().ok()),
            }?;
            Some((card.pci.clone(), serde_json::json!({ "render": busy, "copy": null })))
        })
        .collect()
}

// same shape as the windows sample, only what needs no root. null on the first call
pub fn sample() -> serde_json::Value {
    let now = cpu_jiffies();
    let previous = std::mem::replace(&mut *LAST.lock().unwrap(), now);
    let busy = match (previous, now) {
        (Some((busy_a, total_a)), Some((busy_b, total_b))) if total_b > total_a => {
            Some(((busy_b - busy_a) as f64 * 1000.0 / (total_b - total_a) as f64).round() / 10.0)
        }
        _ => return serde_json::Value::Null,
    };
    serde_json::json!({
        "cpuSpeed": cpu_speed(),
        "cpuBusy": busy,
        "cpuLimit": null,
        "thermalLimit": null,
        "temperature": temperature(),
        "gpu": gpu_load(),
        "nvidia": nvidia::telemetry(),
    })
}
