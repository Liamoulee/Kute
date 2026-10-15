use super::{nvidia, sys};
use crate::debug_print;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

// one drm device. the pci address stands in for the windows luid, both are opaque ids to the page
pub struct Card {
    pub pci: String,
    pub driver: String,
    pub vendor_id: u32,
    pub device_id: u32,
    // /sys/class/drm/cardN/device
    pub device: PathBuf,
    pub index: u32,
}

pub struct Adapter {
    pub card: &'static Card,
    pub name: String,
    pub vram_mb: u64,
    // connectors with a display attached, "DP-1", the names xrandr shows
    pub outputs: Vec<String>,
}

fn hex(path: impl AsRef<Path>) -> u32 {
    sys::read_trimmed(path)
        .and_then(|text| u32::from_str_radix(text.trim_start_matches("0x"), 16).ok())
        .unwrap_or(0)
}

fn file_name(path: &Path) -> Option<String> {
    Some(path.file_name()?.to_str()?.to_string())
}

// gpus do not come and go while kute runs, and load samples ask every 250 ms
pub fn cards() -> &'static [Card] {
    static CARDS: OnceLock<Vec<Card>> = OnceLock::new();
    CARDS.get_or_init(|| {
        let Ok(entries) = fs::read_dir("/sys/class/drm") else { return Vec::new() };
        let mut cards: Vec<Card> = entries
            .flatten()
            .filter_map(|entry| {
                let index = entry.file_name().to_str()?.strip_prefix("card")?.parse().ok()?;
                let device = entry.path().join("device");
                Some(Card {
                    pci: file_name(&fs::canonicalize(&device).ok()?)?,
                    driver: fs::read_link(device.join("driver")).ok().as_deref().and_then(file_name).unwrap_or_default(),
                    vendor_id: hex(device.join("vendor")),
                    device_id: hex(device.join("device")),
                    device,
                    index,
                })
            })
            .collect();
        cards.sort_by_key(|card| card.index);
        cards
    })
}

pub fn card_by_pci(pci: &str) -> Option<&'static Card> {
    cards().iter().find(|card| card.pci == pci)
}

fn connected_outputs(card: &Card) -> Vec<String> {
    let prefix = format!("card{}-", card.index);
    let Ok(entries) = fs::read_dir("/sys/class/drm") else { return Vec::new() };
    let mut outputs: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let connector = entry.file_name().to_str()?.strip_prefix(&prefix)?.to_string();
            (sys::read_trimmed(entry.path().join("status")).as_deref() == Some("connected")).then_some(connector)
        })
        .collect();
    outputs.sort();
    outputs
}

// "[GeForce RTX 3090 Ti]" is the marketing name inside pci.ids' chip name, "NVIDIA Corporation" the vendor
fn short_name(name: &str) -> &str {
    match (name.find('['), name.rfind(']')) {
        (Some(start), Some(end)) if start < end => &name[start + 1..end],
        _ => name.trim_end_matches(" Corporation"),
    }
}

fn pci_ids_name(vendor_id: u32, device_id: u32) -> Option<String> {
    let text = ["/usr/share/hwdata/pci.ids", "/usr/share/misc/pci.ids"]
        .iter()
        .find_map(|path| fs::read_to_string(path).ok())?;
    let vendor_key = format!("{vendor_id:04x}  ");
    let device_key = format!("\t{device_id:04x}  ");
    let mut lines = text.lines().skip_while(|line| !line.starts_with(&vendor_key));
    let vendor = lines.next()?[vendor_key.len()..].to_string();
    let device = lines
        .take_while(|line| line.starts_with('\t') || line.starts_with('#'))
        .find_map(|line| line.strip_prefix(&device_key))?;
    Some(format!("{} {}", short_name(&vendor), short_name(device)))
}

fn name_of(card: &Card) -> String {
    // the proprietary driver knows the exact model, pci.ids only the chip for some boards
    let model = (card.driver == "nvidia")
        .then(|| sys::proc_field(&format!("/proc/driver/nvidia/gpus/{}/information", card.pci), "Model"))
        .flatten();
    model
        .or_else(|| pci_ids_name(card.vendor_id, card.device_id))
        .unwrap_or_else(|| format!("{:04x}:{:04x}", card.vendor_id, card.device_id))
}

fn vram_mb(card: &Card) -> u64 {
    if card.driver == "nvidia" {
        return nvidia::vram_mb(&card.pci).unwrap_or(0);
    }
    // amdgpu. intel and other shared memory chips report 0, like a windows igpu without dedicated memory
    sys::read_trimmed(card.device.join("mem_info_vram_total"))
        .and_then(|bytes| bytes.parse::<u64>().ok())
        .map(|bytes| bytes >> 20)
        .unwrap_or(0)
}

pub fn adapters() -> Vec<Adapter> {
    cards()
        .iter()
        .map(|card| Adapter {
            card,
            name: name_of(card),
            vram_mb: vram_mb(card),
            outputs: connected_outputs(card),
        })
        .collect()
}

// "Device Minor" of the proprietary driver, what /dev/nvidiaN is numbered by
fn nvidia_minors() -> HashMap<u32, String> {
    cards()
        .iter()
        .filter(|card| card.driver == "nvidia")
        .filter_map(|card| {
            let minor = sys::proc_field(&format!("/proc/driver/nvidia/gpus/{}/information", card.pci), "Device Minor")?;
            Some((minor.parse().ok()?, card.pci.clone()))
        })
        .collect()
}

fn gpu_process() -> Option<i32> {
    sys::child_pids()
        .into_iter()
        .find(|pid| fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|cmdline| cmdline.windows(18).any(|arg| arg == b"--type=gpu-process")))
}

// the gpu the game renders on, from the device files the gpu process holds open. a gpu process holding two chips
// (it may open the other one for video decode) says nothing, like an unobserved swap chain on windows
pub fn render_adapter() -> Option<String> {
    let pid = gpu_process()?;
    let minors = nvidia_minors();
    let mut used: Vec<String> = fs::read_dir(format!("/proc/{pid}/fd"))
        .ok()?
        .flatten()
        .filter_map(|fd| {
            let target = fs::read_link(fd.path()).ok()?;
            let name = target.strip_prefix("/dev").ok()?.to_str()?.to_string();
            if let Some(node) = name.strip_prefix("dri/") {
                return file_name(&fs::canonicalize(format!("/sys/class/drm/{node}/device")).ok()?);
            }
            minors.get(&name.strip_prefix("nvidia")?.parse().ok()?).cloned()
        })
        .collect();
    used.sort();
    used.dedup();
    match used.as_slice() {
        [pci] => Some(pci.clone()),
        _ => None,
    }
}

// first line of /proc/driver/nvidia/version, "NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.54.14  ..."
fn driver_major(text: &str) -> Option<u32> {
    text.lines().next()?.split_whitespace().find_map(|word| {
        let (major, rest) = word.split_once('.')?;
        rest.starts_with(|c: char| c.is_ascii_digit()).then(|| major.parse().ok()).flatten()
    })
}

// render offload needs driver 435 or newer, an older one leaves the game black under these variables
const PRIME_MIN_DRIVER: u32 = 435;
const PRIME_VARS: [(&str, &str); 3] = [
    ("__NV_PRIME_RENDER_OFFLOAD", "1"),
    ("__GLX_VENDOR_LIBRARY_NAME", "nvidia"),
    ("__VK_LAYER_NV_optimus", "NVIDIA_only"),
];

static PRIME_OFFLOAD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn prime_offload() -> bool {
    PRIME_OFFLOAD.load(std::sync::atomic::Ordering::Relaxed)
}

// before cef starts, every subprocess inherits the environment. only a real hybrid: the display hangs on another chip
// than the nvidia one. a player who already picked (prime-run, DRI_PRIME) keeps that
pub fn apply_hybrid_defaults() {
    if !crate::utils::config("primeOffload", true) {
        return;
    }
    if ["__NV_PRIME_RENDER_OFFLOAD", "__GLX_VENDOR_LIBRARY_NAME", "__VK_LAYER_NV_optimus", "DRI_PRIME"]
        .iter()
        .any(|name| std::env::var_os(name).is_some())
    {
        debug_print!("gpu: offload variables already set, prime offload left alone");
        return;
    }
    let Some(major) = fs::read_to_string("/proc/driver/nvidia/version").ok().as_deref().and_then(driver_major) else {
        return;
    };
    let nvidia = cards().iter().any(|card| card.driver == "nvidia");
    let display_elsewhere = cards().iter().any(|card| card.driver != "nvidia" && !connected_outputs(card).is_empty());
    if !nvidia || !display_elsewhere {
        return;
    }
    if major < PRIME_MIN_DRIVER {
        debug_print!("gpu: hybrid graphics, nvidia driver {major} is too old for prime offload");
        return;
    }
    for (name, value) in PRIME_VARS {
        // cef has not started, the only other threads are ours and std locks its own env access
        unsafe { std::env::set_var(name, value) };
    }
    PRIME_OFFLOAD.store(true, std::sync::atomic::Ordering::Relaxed);
    debug_print!("gpu: hybrid graphics, prime offload to the nvidia gpu (driver {major})");
}

#[cfg(test)]
mod tests {
    #[test]
    fn driver_major_reads_both_kernel_modules() {
        assert_eq!(
            driver_major("NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.54.14  Thu Feb 22 01:44:30 UTC 2024\nGCC version:"),
            Some(550)
        );
        assert_eq!(
            driver_major("NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  560.35.03  Release Build"),
            Some(560)
        );
        assert_eq!(driver_major("NVRM version: NVIDIA UNIX x86_64 Kernel Module  390.157  Wed Oct 12"), Some(390));
        assert_eq!(driver_major(""), None);
    }

    use super::{driver_major, short_name};

    #[test]
    fn pci_ids_names() {
        assert_eq!(short_name("GA102 [GeForce RTX 3090 Ti]"), "GeForce RTX 3090 Ti");
        assert_eq!(short_name("NVIDIA Corporation"), "NVIDIA");
        assert_eq!(short_name("Advanced Micro Devices, Inc. [AMD/ATI]"), "AMD/ATI");
        assert_eq!(short_name("AlderLake-S GT1"), "AlderLake-S GT1");
    }
}
