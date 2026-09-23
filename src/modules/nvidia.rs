// Gives kute.exe its own NVIDIA driver profile ("Kute"), once per PC.
use std::{ffi::c_void, mem};

use windows::{
    Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW},
    core::{s, w},
};

use crate::{debug_print, utils::config};

const PROFILE_NAME: &str = "Kute";
const APP_NAME: &str = "kute.exe";
// settings.json: set once the profile exists (or kute.exe has one), after that NVAPI is never loaded again
const DONE_SETTING: &str = "nvidiaProfileCreated";

// NvAPI_Status (nvapi_lite_common.h)
const NVAPI_OK: i32 = 0;
const NVAPI_INVALID_USER_PRIVILEGE: i32 = -137;
const NVAPI_EXECUTABLE_ALREADY_IN_USE: i32 = -167;

// NvApiDriverSettings.h: Max Frame Rate off, V-Sync "use the 3D application setting"
const FRL_FPS_ID: u32 = 0x1083_5002;
const FRL_FPS_DISABLED: u32 = 0;
const VSYNCMODE_ID: u32 = 0x00A8_79CF;
const VSYNCMODE_PASSIVE: u32 = 0x6092_5292;
const NVDRS_DWORD_TYPE: u32 = 0;

const UNICODE_MAX: usize = 2048;
type UnicodeString = [u16; UNICODE_MAX];

// NVDRS_SETTING_V1, #pragma pack(4): both unions are as big as NVDRS_BINARY_SETTING (4 + 4096 bytes)
#[repr(C, packed(4))]
struct DrsSetting {
    version: u32,
    setting_name: UnicodeString,
    setting_id: u32,
    setting_type: u32,
    setting_location: u32,
    is_current_predefined: u32,
    is_predefined_valid: u32,
    predefined: [u8; 4100],
    current: [u8; 4100],
}

// NVDRS_APPLICATION_V4
#[repr(C)]
struct DrsApplication {
    version: u32,
    is_predefined: u32,
    app_name: UnicodeString,
    user_friendly_name: UnicodeString,
    launcher: UnicodeString,
    file_in_folder: UnicodeString,
    flags: u32,
    command_line: UnicodeString,
}

// NVDRS_PROFILE_V1
#[repr(C)]
struct DrsProfile {
    version: u32,
    profile_name: UnicodeString,
    gpu_support: u32,
    is_predefined: u32,
    num_of_apps: u32,
    num_of_settings: u32,
}

const _: () = assert!(mem::size_of::<DrsSetting>() == 12320);
const _: () = assert!(mem::size_of::<DrsApplication>() == 20492);
const _: () = assert!(mem::size_of::<DrsProfile>() == 4116);

type Handle = *mut c_void;

// a zeroed struct with its version set (MAKE_NVAPI_VERSION: the size, the version above it), boxed: kilobytes big
fn versioned<T>(ver: u32) -> Box<T> {
    unsafe {
        let mut value: Box<T> = Box::new(mem::zeroed());
        *(value.as_mut() as *mut T as *mut u32) = mem::size_of::<T>() as u32 | (ver << 16);
        value
    }
}

fn unicode(text: &str) -> UnicodeString {
    let mut buffer = [0u16; UNICODE_MAX];
    for (slot, unit) in buffer.iter_mut().zip(text.encode_utf16().take(UNICODE_MAX - 1)) {
        *slot = unit;
    }
    buffer
}

enum Outcome {
    Created,
    // a "Kute" profile exists, or kute.exe belongs to another profile: nothing to do, ever
    AlreadyThere,
    // no NVIDIA driver, no rights, an error: try again next start
    NotNow(String),
}

unsafe fn create() -> Outcome {
    unsafe {
        let Ok(module) = LoadLibraryW(w!("nvapi64.dll")) else {
            return Outcome::NotNow("no NVIDIA driver".into());
        };
        let Some(query) = GetProcAddress(module, s!("nvapi_QueryInterface")) else {
            return Outcome::NotNow("no nvapi_QueryInterface".into());
        };
        let query: unsafe extern "C" fn(u32) -> *const c_void = mem::transmute(query);
        // an entry point by its id (nvapi_interface.h); a missing one is a driver too old for this
        macro_rules! function {
            ($id:expr, $kind:ty) => {{
                let pointer = query($id);
                if pointer.is_null() {
                    return Outcome::NotNow(format!("nvapi function {:#x} missing", $id as u32));
                }
                mem::transmute::<*const c_void, $kind>(pointer)
            }};
        }
        let initialize = function!(0x0150_e828u32, unsafe extern "C" fn() -> i32);
        let create_session = function!(0x0694_d52eu32, unsafe extern "C" fn(*mut Handle) -> i32);
        let destroy_session = function!(0xdad9_cff8u32, unsafe extern "C" fn(Handle) -> i32);
        let load_settings = function!(0x375d_bd6bu32, unsafe extern "C" fn(Handle) -> i32);
        let save_settings = function!(0xfcbc_7e14u32, unsafe extern "C" fn(Handle) -> i32);
        let find_profile = function!(0x7e4a_9a0bu32, unsafe extern "C" fn(Handle, *const u16, *mut Handle) -> i32);
        let create_profile = function!(0xcc17_6068u32, unsafe extern "C" fn(Handle, *mut DrsProfile, *mut Handle) -> i32);
        let delete_profile = function!(0x1709_3206u32, unsafe extern "C" fn(Handle, Handle) -> i32);
        let create_application = function!(0x4347_a9deu32, unsafe extern "C" fn(Handle, Handle, *mut DrsApplication) -> i32);
        let set_setting = function!(0x577d_d202u32, unsafe extern "C" fn(Handle, Handle, *mut DrsSetting) -> i32);

        let status = initialize();
        if status != NVAPI_OK {
            return Outcome::NotNow(format!("NvAPI_Initialize {status}"));
        }
        let mut session: Handle = std::ptr::null_mut();
        let status = create_session(&mut session);
        if status != NVAPI_OK {
            return Outcome::NotNow(format!("DRS_CreateSession {status}"));
        }
        // everything below ends the session on its way out
        let outcome = (|| {
            let status = load_settings(session);
            if status != NVAPI_OK {
                return Outcome::NotNow(format!("DRS_LoadSettings {status}"));
            }
            let name = unicode(PROFILE_NAME);
            let mut profile: Handle = std::ptr::null_mut();
            if find_profile(session, name.as_ptr(), &mut profile) == NVAPI_OK {
                return Outcome::AlreadyThere;
            }

            let mut info = versioned::<DrsProfile>(1);
            info.profile_name = name;
            let status = create_profile(session, info.as_mut(), &mut profile);
            if status != NVAPI_OK {
                return Outcome::NotNow(format!("DRS_CreateProfile {status}"));
            }
            let mut application = versioned::<DrsApplication>(4);
            application.app_name = unicode(APP_NAME);
            application.user_friendly_name = unicode("Kute");
            let status = create_application(session, profile, application.as_mut());
            if status != NVAPI_OK {
                // unsaved, so dropping the profile again leaves the database as it was
                delete_profile(session, profile);
                return if status == NVAPI_EXECUTABLE_ALREADY_IN_USE {
                    Outcome::AlreadyThere
                } else {
                    Outcome::NotNow(format!("DRS_CreateApplication {status}"))
                };
            }
            for (id, value) in [(FRL_FPS_ID, FRL_FPS_DISABLED), (VSYNCMODE_ID, VSYNCMODE_PASSIVE)] {
                let mut setting = versioned::<DrsSetting>(1);
                setting.setting_id = id;
                setting.setting_type = NVDRS_DWORD_TYPE;
                setting.current[..4].copy_from_slice(&value.to_le_bytes());
                let status = set_setting(session, profile, setting.as_mut());
                if status != NVAPI_OK {
                    return Outcome::NotNow(format!("DRS_SetSetting {id:#x} {status}"));
                }
            }
            match save_settings(session) {
                NVAPI_OK => Outcome::Created,
                NVAPI_INVALID_USER_PRIVILEGE => Outcome::NotNow("saving needs administrator rights".into()),
                status => Outcome::NotNow(format!("DRS_SaveSettings {status}")),
            }
        })();
        destroy_session(session);
        outcome
    }
}

// Browser process, before CEF starts. Does nothing once it has done its job on this PC.
pub fn ensure_profile() {
    if config(DONE_SETTING, false) {
        return;
    }
    let _started = std::time::Instant::now();
    let outcome = unsafe { create() };
    let _ms = _started.elapsed().as_secs_f64() * 1000.0;
    match outcome {
        Outcome::Created => debug_print!("nvidia: created the Kute driver profile ({_ms:.0} ms)"),
        Outcome::AlreadyThere => debug_print!("nvidia: a Kute profile exists or kute.exe has one, left alone ({_ms:.0} ms)"),
        Outcome::NotNow(_reason) => {
            debug_print!("nvidia: no driver profile this time: {_reason} ({_ms:.0} ms)");
            return;
        }
    }
    crate::CONFIG.lock().unwrap().set(DONE_SETTING, true);
    crate::config::save_soon();
}
