use std::{fs, mem::size_of_val, path::Path, time::Duration};

use windows::{
    Win32::{
        Foundation::{CloseHandle, ERROR_NOTIFY_ENUM_DIR, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
        Storage::FileSystem::{
            CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED, FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
            FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, ReadDirectoryChangesW,
        },
        System::{
            IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
            Threading::{CreateEventW, INFINITE, WaitForSingleObject},
        },
    },
    core::{Error, HSTRING, Result},
};

use crate::{debug_print, modules::swapper};

// a copied pack is hundreds of events, it gets one rescan once the folder was quiet this long
const QUIET_MS: u32 = 300;

// files dropped in with explorer apply to the next file the game asks for, no reload. the thread sleeps in the
// kernel until the folder changes, nothing polls
pub fn start() {
    std::thread::Builder::new()
        .name("kute-swapper-watch".into())
        .spawn(|| {
            loop {
                if let Err(e) = watch(&swapper::swapper_dir()) {
                    debug_print!("swapper watch: {e}");
                }
                // folder deleted or renamed, the next scan creates it again
                std::thread::sleep(Duration::from_secs(5));
            }
        })
        .ok();
}

fn watch(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).ok();
    let mut watcher = Watcher::open(dir)?;
    watcher.arm()?;
    loop {
        watcher.wait(INFINITE)?;
        // armed again right away, nothing that changes during the rescan gets lost
        watcher.arm()?;
        while watcher.wait(QUIET_MS)? {
            watcher.arm()?;
        }
        let started = std::time::Instant::now();
        swapper::reload();
        debug_print!("swapper watch: folder changed, rescan took {:?}", started.elapsed());
    }
}

struct Watcher {
    dir: HANDLE,
    event: HANDLE,
    // the kernel writes into both while a read is pending, boxed so they never move
    overlapped: Box<OVERLAPPED>,
    buffer: Box<[u32; 4096]>,
    pending: bool,
}

impl Watcher {
    fn open(dir: &Path) -> Result<Self> {
        unsafe {
            let dir = CreateFileW(
                &HSTRING::from(dir.as_os_str()),
                FILE_LIST_DIRECTORY.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                None,
            )?;
            let event = match CreateEventW(None, true, false, None) {
                Ok(event) => event,
                Err(e) => {
                    CloseHandle(dir).ok();
                    return Err(e);
                }
            };
            Ok(Self {
                dir,
                event,
                overlapped: Box::default(),
                buffer: Box::new([0; 4096]),
                pending: false,
            })
        }
    }

    // only the wakeup counts, the rescan compares names, sizes and mtimes itself
    fn arm(&mut self) -> Result<()> {
        *self.overlapped = OVERLAPPED {
            hEvent: self.event,
            ..Default::default()
        };
        let filter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE;
        unsafe {
            ReadDirectoryChangesW(
                self.dir,
                self.buffer.as_mut_ptr().cast(),
                size_of_val(&*self.buffer) as u32,
                true,
                filter,
                None,
                Some(&mut *self.overlapped),
                None,
            )?;
        }
        self.pending = true;
        Ok(())
    }

    // false on timeout
    fn wait(&mut self, timeout_ms: u32) -> Result<bool> {
        let woke = unsafe { WaitForSingleObject(self.event, timeout_ms) };
        if woke == WAIT_TIMEOUT {
            return Ok(false);
        }
        if woke != WAIT_OBJECT_0 {
            return Err(Error::from_thread());
        }
        self.pending = false;
        let mut bytes = 0;
        match unsafe { GetOverlappedResult(self.dir, &*self.overlapped, &mut bytes, false) } {
            // more changes than the buffer holds, still just a change
            Err(e) if e.code() != ERROR_NOTIFY_ENUM_DIR.to_hresult() => Err(e),
            _ => Ok(true),
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        unsafe {
            if self.pending {
                CancelIoEx(self.dir, Some(&*self.overlapped)).ok();
                // the kernel must be done with the buffer before it is freed
                let mut bytes = 0;
                GetOverlappedResult(self.dir, &*self.overlapped, &mut bytes, true).ok();
            }
            CloseHandle(self.event).ok();
            CloseHandle(self.dir).ok();
        }
    }
}
