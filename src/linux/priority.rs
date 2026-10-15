use super::sys;
use crate::{debug_print, utils::config};
use std::fs;

// raising priority needs CAP_SYS_NICE, so High and Above Normal only work for a user allowed to renice
fn nice_of(level: &str) -> i32 {
    match level {
        "High" => -10,
        "Above Normal" => -5,
        "Below Normal" => 5,
        "Low" | "Idle" => 19,
        _ => 0,
    }
}

fn renice(tid: i32, nice: i32) {
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, tid as libc::id_t, nice);
    }
}

pub fn high_qos_self() {}

// (size in KiB, cpus sharing it) per distinct L3
fn l3_caches() -> Vec<(u64, Vec<usize>)> {
    let mut caches: Vec<(u64, Vec<usize>)> = Vec::new();
    let Ok(cpus) = fs::read_dir("/sys/devices/system/cpu") else { return caches };
    for cpu in cpus.flatten() {
        let Ok(indexes) = fs::read_dir(cpu.path().join("cache")) else { continue };
        for index in indexes.flatten().map(|entry| entry.path()) {
            if sys::read_trimmed(index.join("level")).as_deref() != Some("3") {
                continue;
            }
            let (Some(size), Some(shared)) = (
                sys::read_trimmed(index.join("size")).and_then(|size| size.trim_end_matches('K').parse().ok()),
                sys::read_trimmed(index.join("shared_cpu_list")).map(|list| cpu_list(&list)),
            ) else {
                continue;
            };
            if !caches.iter().any(|(_, cpus)| *cpus == shared) {
                caches.push((size, shared));
            }
        }
    }
    caches
}

// "0-7,16-23" -> [0..=7, 16..=23]
fn cpu_list(list: &str) -> Vec<usize> {
    list.split(',')
        .filter_map(|range| match range.split_once('-') {
            Some((start, end)) => Some((start.trim().parse().ok()?..=end.trim().parse().ok()?).collect::<Vec<usize>>()),
            None => Some(vec![range.trim().parse().ok()?]),
        })
        .flatten()
        .collect()
}

// the cores of the largest L3 when the L3s differ in size (Ryzen X3D with two CCDs). one L3 or equal ones: nothing to prefer
fn pick_cache_cores(caches: &[(u64, Vec<usize>)]) -> Option<&[usize]> {
    let (largest, cpus) = caches.iter().max_by_key(|(size, _)| *size)?;
    (caches.len() >= 2 && caches.iter().any(|(size, _)| size != largest)).then_some(cpus.as_slice())
}

// before cef starts: affinity is per thread on linux, threads and processes made after this inherit it
pub fn prefer_cache_cores() {
    if !config("x3dCacheCores", true) {
        return;
    }
    let caches = l3_caches();
    let Some(cores) = pick_cache_cores(&caches) else { return };
    unsafe {
        let mut current: libc::cpu_set_t = std::mem::zeroed();
        if libc::sched_getaffinity(0, size_of::<libc::cpu_set_t>(), &mut current) != 0 {
            return;
        }
        // a mask someone set on purpose (taskset, a tuning tool) stays the outer limit
        let mut wanted: libc::cpu_set_t = std::mem::zeroed();
        for &cpu in cores.iter().filter(|&&cpu| cpu < libc::CPU_SETSIZE as usize && libc::CPU_ISSET(cpu, &current)) {
            libc::CPU_SET(cpu, &mut wanted);
        }
        let count = libc::CPU_COUNT(&wanted);
        if count == 0 || count == libc::CPU_COUNT(&current) {
            return;
        }
        if libc::sched_setaffinity(0, size_of::<libc::cpu_set_t>(), &wanted) == 0 {
            debug_print!("priority: kept on the largest L3, {count} threads");
        }
    }
}

// before the subprocess spawns threads, they inherit it
pub fn apply_to_self() {
    let level = config("webviewPriority", "Normal".to_string());
    if level != "Normal" {
        renice(0, nice_of(&level));
    }
}

pub fn set(level: impl AsRef<str>) {
    let nice = nice_of(level.as_ref());
    let own = std::process::id() as i32;
    for pid in std::iter::once(own).chain(sys::child_pids()) {
        for tid in sys::thread_ids(pid) {
            renice(tid, nice);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{cpu_list, pick_cache_cores};

    #[test]
    fn picks_the_bigger_cache_on_x3d() {
        // 7950X3D: CCD0 96 MB with threads 0-7 and 16-23, CCD1 32 MB with the rest
        let caches = [(98304, cpu_list("0-7,16-23")), (32768, cpu_list("8-15,24-31"))];
        assert_eq!(pick_cache_cores(&caches), Some(cpu_list("0-7,16-23").as_slice()));
        let swapped = [(32768, cpu_list("0-7")), (98304, cpu_list("8-15"))];
        assert_eq!(pick_cache_cores(&swapped), Some(cpu_list("8-15").as_slice()));
    }

    #[test]
    fn leaves_everything_else_alone() {
        assert_eq!(pick_cache_cores(&[(30720, cpu_list("0-23"))]), None);
        assert_eq!(pick_cache_cores(&[(32768, cpu_list("0-7")), (32768, cpu_list("8-15"))]), None);
        assert_eq!(pick_cache_cores(&[]), None);
    }

    #[test]
    fn cpu_lists() {
        assert_eq!(cpu_list("0-3,8,10-11"), vec![0, 1, 2, 3, 8, 10, 11]);
        assert_eq!(cpu_list("5"), vec![5]);
    }
}
