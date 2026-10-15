use std::{fs, path::Path};

pub fn read_trimmed(path: impl AsRef<Path>) -> Option<String> {
    fs::read_to_string(path).ok().map(|text| text.trim().to_string())
}

// "key: value" lines as in /proc/cpuinfo and /proc/meminfo
pub fn proc_field(path: &str, key: &str) -> Option<String> {
    fs::read_to_string(path).ok()?.lines().find_map(|line| {
        line.split_once(':')
            .filter(|(name, _)| name.trim() == key)
            .map(|(_, value)| value.trim().to_string())
    })
}

// pids whose parent is this process, cef's subprocesses
pub fn child_pids() -> Vec<i32> {
    let own = std::process::id() as i32;
    let Ok(entries) = fs::read_dir("/proc") else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
        .filter(|pid| parent_of(*pid) == Some(own))
        .collect()
}

// field 4 of /proc/<pid>/stat, after the parenthesized name which may hold spaces
fn parent_of(pid: i32) -> Option<i32> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_name = &stat[stat.rfind(')')? + 1..];
    after_name.split_whitespace().nth(1)?.parse().ok()
}

// every thread of a process, nice is per thread on linux
pub fn thread_ids(pid: i32) -> Vec<i32> {
    let Ok(entries) = fs::read_dir(format!("/proc/{pid}/task")) else {
        return Vec::new();
    };
    entries.flatten().filter_map(|entry| entry.file_name().to_str()?.parse().ok()).collect()
}

// xdg-open for folders, files and urls
pub fn open(target: impl AsRef<std::ffi::OsStr>) {
    std::process::Command::new("xdg-open").arg(target).spawn().ok();
}

// utime + stime of this process and its children (gpu, renderer, utilities), ms
pub fn process_tree_cpu_ms() -> u64 {
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u64;
    let own = std::process::id() as i32;
    std::iter::once(own)
        .chain(child_pids())
        .filter_map(|pid| {
            let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let fields: Vec<&str> = stat[stat.rfind(')')? + 1..].split_whitespace().collect();
            // utime and stime are fields 14 and 15, the slice starts at field 3
            Some(fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?)
        })
        .sum::<u64>()
        * 1000
        / ticks
}
