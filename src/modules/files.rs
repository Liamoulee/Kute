//! File operations the userscript and swapper managers ask for. The page only ever names a path relative to one
//! of our folders, everything here makes sure it stays inside that folder.

use std::{
    io,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
};

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

// standard base64 (the page sends dropped files as data URLs), None on anything else
pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let bytes = text.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        if chunk.len() == 1 {
            return None;
        }
        let mut buffer = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            buffer |= value(c)? << (18 - 6 * i);
        }
        out.push((buffer >> 16) as u8);
        if chunk.len() > 2 {
            out.push((buffer >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(buffer as u8);
        }
    }
    Some(out)
}
