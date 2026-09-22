//! File operations the userscript and swapper managers ask for. The page only ever names a path relative to one
//! of our folders, everything here makes sure it stays inside that folder.

use std::{
    fs, io,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

// set while a manager popup is open: only then an external drag may enter the page
static DROP_ZONE: AtomicBool = AtomicBool::new(false);
// the files of the last external drag, the page only says where they go
static DROPPED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

pub fn set_drop_zone(open: bool) {
    DROP_ZONE.store(open, Ordering::Relaxed);
    if !open {
        DROPPED.lock().unwrap().clear();
    }
}

pub fn drop_zone_open() -> bool {
    DROP_ZONE.load(Ordering::Relaxed)
}

pub fn set_dropped(paths: Vec<PathBuf>) {
    *DROPPED.lock().unwrap() = paths;
}

pub fn take_dropped() -> Vec<PathBuf> {
    std::mem::take(&mut *DROPPED.lock().unwrap())
}

// one file or folder name as Windows accepts it
pub fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && name != "."
        && name != ".."
        && !name.ends_with([' ', '.'])
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
}

// "a/b/c.png" (either slash) -> a relative path of safe names, or None. Empty means the folder itself
pub fn safe_relative(path: &str) -> Option<PathBuf> {
    let mut relative = PathBuf::new();
    let parts: Vec<&str> = path.split(['/', '\\']).filter(|part| !part.is_empty()).collect();
    if parts.len() > 16 {
        return None;
    }
    for part in parts {
        if !safe_name(part) {
            return None;
        }
        relative.push(part);
    }
    Some(relative)
}

// forward slashes, like the urls the swapper matches
pub fn to_slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

// moves a file or folder to the recycle bin, so a wrong click is never final
pub fn recycle(path: &Path) -> io::Result<()> {
    use windows::Win32::UI::Shell::{FO_DELETE, FOF_ALLOWUNDO, FOF_NO_UI, SHFILEOPSTRUCTW, SHFileOperationW};

    let wide: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().chain([0, 0]).collect();
    let mut operation = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: windows::core::PCWSTR(wide.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NO_UI).0 as u16,
        ..Default::default()
    };
    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 || operation.fAnyOperationsAborted.as_bool() {
        return Err(io::Error::other(format!("SHFileOperationW failed with {result}")));
    }
    Ok(())
}

// opens the folder, or the folder of a file with the file selected
pub fn reveal(path: &Path) {
    let mut command = std::process::Command::new("explorer.exe");
    if path.is_file() {
        // explorer parses its own command line, the quotes have to sit after the comma
        command.raw_arg(format!("/select,\"{}\"", path.display()));
    } else {
        command.arg(path);
    }
    command.spawn().ok();
}

// copies a file, or a folder with everything in it, into `target` (which must not exist yet as a file)
pub fn copy_into(source: &Path, target: &Path) -> io::Result<()> {
    if source.is_dir() {
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)?.flatten() {
            copy_into(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source, target).map(|_| ())
}
