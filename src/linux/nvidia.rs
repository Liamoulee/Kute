use std::{
    ffi::{CStr, CString, c_char, c_int, c_uint, c_void},
    sync::OnceLock,
};

// NVAPI driver profiles exist on windows only, the linux driver reads __GL_* env vars and nvidia-settings
pub fn ensure_profile() {}

type Device = *mut c_void;

// nvml from the driver package, loaded at runtime like nvapi64.dll: a pc without the proprietary driver has none.
// every value is the driver's own number, report only
struct Nvml {
    count: unsafe extern "C" fn(*mut c_uint) -> c_int,
    by_index: unsafe extern "C" fn(c_uint, *mut Device) -> c_int,
    by_pci: unsafe extern "C" fn(*const c_char, *mut Device) -> c_int,
    // nvmlUtilization_t: gpu, memory
    utilization: unsafe extern "C" fn(Device, *mut [c_uint; 2]) -> c_int,
    clock: unsafe extern "C" fn(Device, c_uint, *mut c_uint) -> c_int,
    temperature: unsafe extern "C" fn(Device, c_uint, *mut c_uint) -> c_int,
    reasons: unsafe extern "C" fn(Device, *mut u64) -> c_int,
    // nvmlMemory_t: total, free, used
    memory: unsafe extern "C" fn(Device, *mut [u64; 3]) -> c_int,
}

const SUCCESS: c_int = 0;
const CLOCK_GRAPHICS: c_uint = 0;
const TEMPERATURE_GPU: c_uint = 0;

fn nvml() -> Option<&'static Nvml> {
    static NVML: OnceLock<Option<Nvml>> = OnceLock::new();
    NVML.get_or_init(|| unsafe { open() }).as_ref()
}

// a dlsym result as the function type it is declared as
unsafe fn cast<F: Copy>(symbol: *mut c_void) -> F {
    assert_eq!(size_of::<F>(), size_of::<*mut c_void>());
    unsafe { std::mem::transmute_copy(&symbol) }
}

unsafe fn open() -> Option<Nvml> {
    unsafe {
        let library = libc::dlopen(c"libnvidia-ml.so.1".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        if library.is_null() {
            return None;
        }
        let symbol = |name: &CStr| Some(libc::dlsym(library, name.as_ptr())).filter(|symbol| !symbol.is_null());
        let init: unsafe extern "C" fn() -> c_int = cast(symbol(c"nvmlInit_v2")?);
        if init() != SUCCESS {
            return None;
        }
        Some(Nvml {
            count: cast(symbol(c"nvmlDeviceGetCount_v2")?),
            by_index: cast(symbol(c"nvmlDeviceGetHandleByIndex_v2")?),
            by_pci: cast(symbol(c"nvmlDeviceGetHandleByPciBusId_v2")?),
            utilization: cast(symbol(c"nvmlDeviceGetUtilizationRates")?),
            clock: cast(symbol(c"nvmlDeviceGetClockInfo")?),
            temperature: cast(symbol(c"nvmlDeviceGetTemperature")?),
            // renamed in driver 535, the old name stays exported
            reasons: cast(symbol(c"nvmlDeviceGetCurrentClocksEventReasons").or_else(|| symbol(c"nvmlDeviceGetCurrentClocksThrottleReasons"))?),
            memory: cast(symbol(c"nvmlDeviceGetMemoryInfo")?),
        })
    }
}

fn device(nvml: &Nvml, pci: &str) -> Option<Device> {
    let pci = CString::new(pci).ok()?;
    let mut device = std::ptr::null_mut();
    (unsafe { (nvml.by_pci)(pci.as_ptr(), &mut device) } == SUCCESS).then_some(device)
}

pub fn vram_mb(pci: &str) -> Option<u64> {
    let nvml = nvml()?;
    let mut memory = [0u64; 3];
    (unsafe { (nvml.memory)(device(nvml, pci)?, &mut memory) } == SUCCESS).then_some(memory[0] >> 20)
}

// percent of the last sample period the chip was busy
pub fn busy(pci: &str) -> Option<f64> {
    let nvml = nvml()?;
    let mut rates = [0; 2];
    (unsafe { (nvml.utilization)(device(nvml, pci)?, &mut rates) } == SUCCESS).then_some(rates[0] as f64)
}

// same fields as the windows NVAPI telemetry. heldBack is nvml's clock event reason mask, 0 = nothing holds the clock
pub fn telemetry() -> serde_json::Value {
    let Some(nvml) = nvml() else { return serde_json::Value::Null };
    let mut count = 0;
    if unsafe { (nvml.count)(&mut count) } != SUCCESS {
        return serde_json::Value::Null;
    }
    let gpus: Vec<serde_json::Value> = (0..count)
        .filter_map(|index| unsafe {
            let mut gpu = std::ptr::null_mut();
            if (nvml.by_index)(index, &mut gpu) != SUCCESS {
                return None;
            }
            let (mut clock, mut temperature, mut held) = (0, 0, 0u64);
            Some(serde_json::json!({
                "clockMhz": ((nvml.clock)(gpu, CLOCK_GRAPHICS, &mut clock) == SUCCESS).then_some(clock),
                "temperature": ((nvml.temperature)(gpu, TEMPERATURE_GPU, &mut temperature) == SUCCESS).then_some(temperature),
                "heldBack": ((nvml.reasons)(gpu, &mut held) == SUCCESS).then_some(held),
            }))
        })
        .collect();
    serde_json::Value::Array(gpus)
}
