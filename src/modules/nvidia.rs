use std::{ffi::c_void, mem};

use windows::{
    Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW},
    core::{s, w},
};

use crate::{debug_print, utils::config};

const PROFILE_NAME: &str = "Kute";
const APP_NAME: &str = "kute.exe";
// once both are set, the profile is never touched again
const DONE_SETTING: &str = "nvidiaProfileCreated";
// profiles made before 2026-10-01 have no power management setting, they get it once
const POWER_SETTING: &str = "nvidiaProfilePower";

// NvAPI_Status (nvapi_lite_common.h)
const NVAPI_OK: i32 = 0;
const NVAPI_INVALID_USER_PRIVILEGE: i32 = -137;
const NVAPI_EXECUTABLE_ALREADY_IN_USE: i32 = -167;
const NVAPI_SETTING_NOT_FOUND: i32 = -160;

// NvApiDriverSettings.h: Max Frame Rate off, V-Sync "use the 3D application setting"
const FRL_FPS_ID: u32 = 0x1083_5002;
const FRL_FPS_DISABLED: u32 = 0;
const VSYNCMODE_ID: u32 = 0x00A8_79CF;
const VSYNCMODE_PASSIVE: u32 = 0x6092_5292;
// power management mode "prefer maximum performance". with the driver's default the chip lowers its clock when its load
// comes in short bursts, which is what a game at 500 fps and more looks like to it: a hybrid laptop swung between
// 1378 and 117 fps every 1.6 s without a limit, and ran clean at a fixed 515
const PREFERRED_PSTATE_ID: u32 = 0x1057_EB71;
const PREFERRED_PSTATE_PREFER_MAX: u32 = 1;
const NVDRS_DWORD_TYPE: u32 = 0;
// NVDRS_SETTING_LOCATION: the value is set in this profile, not inherited
const NVDRS_CURRENT_PROFILE_LOCATION: u32 = 0;

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

// zeroed, MAKE_NVAPI_VERSION set, boxed because it's kilobytes
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
    // "Kute" exists or kute.exe is in another profile, never touch it
    AlreadyThere,
    // no driver, no rights, error: retry next start
    NotNow(String),
}

// power: only add the power management setting to the "Kute" profile of an earlier start
unsafe fn create(power: bool) -> Outcome {
    unsafe {
        let Ok(module) = LoadLibraryW(w!("nvapi64.dll")) else {
            return Outcome::NotNow("no NVIDIA driver".into());
        };
        let Some(query) = GetProcAddress(module, s!("nvapi_QueryInterface")) else {
            return Outcome::NotNow("no nvapi_QueryInterface".into());
        };
        let query: unsafe extern "C" fn(u32) -> *const c_void = mem::transmute(query);
        // ids from nvapi_interface.h, missing = driver too old
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
        let get_setting = function!(0x73bf_8338u32, unsafe extern "C" fn(Handle, Handle, u32, *mut DrsSetting) -> i32);

        let status = initialize();
        if status != NVAPI_OK {
            return Outcome::NotNow(format!("NvAPI_Initialize {status}"));
        }
        let mut session: Handle = std::ptr::null_mut();
        let status = create_session(&mut session);
        if status != NVAPI_OK {
            return Outcome::NotNow(format!("DRS_CreateSession {status}"));
        }
        let outcome = (|| {
            let status = load_settings(session);
            if status != NVAPI_OK {
                return Outcome::NotNow(format!("DRS_LoadSettings {status}"));
            }
            let name = unicode(PROFILE_NAME);
            let mut profile: Handle = std::ptr::null_mut();
            let found = find_profile(session, name.as_ptr(), &mut profile) == NVAPI_OK;
            let save = |made: Outcome| match save_settings(session) {
                NVAPI_OK => made,
                NVAPI_INVALID_USER_PRIVILEGE => Outcome::NotNow("saving needs administrator rights".into()),
                status => Outcome::NotNow(format!("DRS_SaveSettings {status}")),
            };
            let set = |profile: Handle, id: u32, value: u32| {
                let mut setting = versioned::<DrsSetting>(1);
                setting.setting_id = id;
                setting.setting_type = NVDRS_DWORD_TYPE;
                setting.current[..4].copy_from_slice(&value.to_le_bytes());
                set_setting(session, profile, setting.as_mut())
            };
            if power {
                // deleted by the player: stays deleted
                if !found {
                    return Outcome::AlreadyThere;
                }
                let mut setting = versioned::<DrsSetting>(1);
                let status = get_setting(session, profile, PREFERRED_PSTATE_ID, setting.as_mut());
                // a mode the player picked in this profile stays
                if status == NVAPI_OK && setting.setting_location == NVDRS_CURRENT_PROFILE_LOCATION {
                    return Outcome::AlreadyThere;
                }
                if status != NVAPI_OK && status != NVAPI_SETTING_NOT_FOUND {
                    return Outcome::NotNow(format!("DRS_GetSetting {status}"));
                }
                let status = set(profile, PREFERRED_PSTATE_ID, PREFERRED_PSTATE_PREFER_MAX);
                if status != NVAPI_OK {
                    return Outcome::NotNow(format!("DRS_SetSetting {PREFERRED_PSTATE_ID:#x} {status}"));
                }
                return save(Outcome::Created);
            }
            if found {
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
                // unsaved, so this leaves the db untouched
                delete_profile(session, profile);
                return if status == NVAPI_EXECUTABLE_ALREADY_IN_USE {
                    Outcome::AlreadyThere
                } else {
                    Outcome::NotNow(format!("DRS_CreateApplication {status}"))
                };
            }
            for (id, value) in [
                (FRL_FPS_ID, FRL_FPS_DISABLED),
                (VSYNCMODE_ID, VSYNCMODE_PASSIVE),
                (PREFERRED_PSTATE_ID, PREFERRED_PSTATE_PREFER_MAX),
            ] {
                let status = set(profile, id, value);
                if status != NVAPI_OK {
                    return Outcome::NotNow(format!("DRS_SetSetting {id:#x} {status}"));
                }
            }
            save(Outcome::Created)
        })();
        destroy_session(session);
        outcome
    }
}

// browser process, before cef starts
pub fn ensure_profile() {
    let created = config(DONE_SETTING, false);
    if created && config(POWER_SETTING, false) {
        return;
    }
    let _started = std::time::Instant::now();
    let outcome = unsafe { create(created) };
    let _ms = _started.elapsed().as_secs_f64() * 1000.0;
    match outcome {
        Outcome::Created if created => debug_print!("nvidia: power management mode added to the Kute driver profile ({_ms:.0} ms)"),
        Outcome::Created => debug_print!("nvidia: created the Kute driver profile ({_ms:.0} ms)"),
        Outcome::AlreadyThere => debug_print!("nvidia: the profile is the player's, left alone ({_ms:.0} ms)"),
        Outcome::NotNow(_reason) => {
            debug_print!("nvidia: no driver profile change this time: {_reason} ({_ms:.0} ms)");
            return;
        }
    }
    let mut settings = crate::CONFIG.lock().unwrap();
    settings.set(DONE_SETTING, true);
    settings.set(POWER_SETTING, true);
    drop(settings);
    crate::config::save_soon();
}

// NV_GPU_CLOCK_FREQUENCIES_V2: domain 0 is the graphics clock, in kHz
#[repr(C)]
struct ClockFrequencies {
    version: u32,
    clock_type: u32,
    domains: [[u32; 2]; 32],
}

// NV_GPU_THERMAL_SETTINGS_V2
#[repr(C)]
struct ThermalSettings {
    version: u32,
    count: u32,
    // controller, default min, default max, current, target
    sensors: [[i32; 5]; 3],
}

const _: () = assert!(mem::size_of::<ClockFrequencies>() == 264);
const _: () = assert!(mem::size_of::<ThermalSettings>() == 68);

struct Telemetry {
    gpus: Vec<usize>,
    clocks: Option<unsafe extern "C" fn(Handle, *mut ClockFrequencies) -> i32>,
    thermal: Option<unsafe extern "C" fn(Handle, u32, *mut ThermalSettings) -> i32>,
    decrease: Option<unsafe extern "C" fn(Handle, *mut u32) -> i32>,
}

static TELEMETRY: std::sync::OnceLock<Option<Telemetry>> = std::sync::OnceLock::new();

unsafe fn open_telemetry() -> Option<Telemetry> {
    unsafe {
        let module = LoadLibraryW(w!("nvapi64.dll")).ok()?;
        let query: unsafe extern "C" fn(u32) -> *const c_void = mem::transmute(GetProcAddress(module, s!("nvapi_QueryInterface"))?);
        let lookup = |id: u32| {
            let pointer = query(id);
            (!pointer.is_null()).then_some(pointer)
        };
        let initialize: unsafe extern "C" fn() -> i32 = mem::transmute(lookup(0x0150_e828)?);
        let enumerate: unsafe extern "C" fn(*mut [Handle; 64], *mut u32) -> i32 = mem::transmute(lookup(0xe5ac_921f)?);
        if initialize() != NVAPI_OK {
            return None;
        }
        let mut handles: [Handle; 64] = [std::ptr::null_mut(); 64];
        let mut count = 0u32;
        if enumerate(&mut handles, &mut count) != NVAPI_OK {
            return None;
        }
        Some(Telemetry {
            gpus: handles[..(count as usize).min(64)].iter().map(|handle| *handle as usize).collect(),
            clocks: lookup(0xdcb6_16c3).map(|pointer| mem::transmute(pointer)),
            thermal: lookup(0xe364_0a56).map(|pointer| mem::transmute(pointer)),
            decrease: lookup(0x7f7f_4600).map(|pointer| mem::transmute(pointer)),
        })
    }
}

// what the NVIDIA chip does right now, for the auto-detect report: clock, temperature and why the driver
// holds it back (bit 1 heat, 2 power limit, 4 running on battery, 16 not enough power from the supply)
pub fn telemetry() -> serde_json::Value {
    let Some(telemetry) = TELEMETRY.get_or_init(|| unsafe { open_telemetry() }) else {
        return serde_json::Value::Null;
    };
    let gpus: Vec<serde_json::Value> = telemetry
        .gpus
        .iter()
        .map(|gpu| unsafe {
            let gpu = *gpu as Handle;
            let clock = telemetry.clocks.and_then(|clocks| {
                let mut frequencies = versioned::<ClockFrequencies>(2);
                (clocks(gpu, frequencies.as_mut()) == NVAPI_OK && frequencies.domains[0][0] & 1 == 1).then(|| frequencies.domains[0][1] / 1000)
            });
            let temperature = telemetry.thermal.and_then(|thermal| {
                let mut settings = versioned::<ThermalSettings>(2);
                // 15: every sensor
                (thermal(gpu, 15, settings.as_mut()) == NVAPI_OK && settings.count > 0).then(|| settings.sensors[0][3])
            });
            let held = telemetry.decrease.and_then(|decrease| {
                let mut reasons = 0u32;
                (decrease(gpu, &mut reasons) == NVAPI_OK).then_some(reasons)
            });
            serde_json::json!({ "clockMhz": clock, "temperature": temperature, "heldBack": held })
        })
        .collect();
    serde_json::Value::Array(gpus)
}
