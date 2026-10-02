use std::{collections::BTreeMap, sync::Mutex};

use windows::{Win32::System::Performance::*, core::*};

// what the PC itself does during an auto-detect reading, from Windows' performance counters: a laptop report showed the
// game collapsing without a limit and nothing in it could say whether the processor or a graphics chip gave way.
// report only, nothing is decided from these

struct Counters {
    query: isize,
    speed: Option<isize>,
    busy: Option<isize>,
    limit: Option<isize>,
    thermal: Option<isize>,
    temperature: Option<isize>,
    gpu: Option<isize>,
}

static COUNTERS: Mutex<Option<Counters>> = Mutex::new(None);

// english names, the localized ones differ per Windows language
fn add(query: PDH_HQUERY, path: PCWSTR) -> Option<isize> {
    let mut counter = PDH_HCOUNTER::default();
    (unsafe { PdhAddEnglishCounterW(query, path, 0, &mut counter) } == 0).then_some(counter.0 as isize)
}

fn open() -> Option<Counters> {
    let mut query = PDH_HQUERY::default();
    if unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) } != 0 {
        return None;
    }
    Some(Counters {
        query: query.0 as isize,
        // above 100 with turbo, far below while the processor is throttled
        speed: add(query, w!("\\Processor Information(_Total)\\% Processor Performance")),
        busy: add(query, w!("\\Processor Information(_Total)\\% Processor Utility")),
        limit: add(query, w!("\\Processor Information(_Total)\\% Performance Limit")),
        thermal: add(query, w!("\\Thermal Zone Information(*)\\% Passive Limit")),
        temperature: add(query, w!("\\Thermal Zone Information(*)\\Temperature")),
        gpu: add(query, w!("\\GPU Engine(*)\\Utilization Percentage")),
    })
}

fn value(counter: Option<isize>) -> Option<f64> {
    let mut value = PDH_FMT_COUNTERVALUE::default();
    let status = unsafe { PdhGetFormattedCounterValue(PDH_HCOUNTER(counter? as *mut _), PDH_FMT_DOUBLE, None, &mut value) };
    (status == 0 && value.CStatus == 0).then_some(unsafe { value.Anonymous.doubleValue })
}

// every instance of a wildcard counter with its name
fn values(counter: Option<isize>) -> Vec<(String, f64)> {
    let Some(counter) = counter.map(|counter| PDH_HCOUNTER(counter as *mut _)) else {
        return Vec::new();
    };
    let (mut size, mut count) = (0u32, 0u32);
    if unsafe { PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None) } != PDH_MORE_DATA || size == 0 {
        return Vec::new();
    }
    // u64 for the alignment of the items, the names live behind them in the same buffer
    let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
    let items = buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
    if unsafe { PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) } != 0 {
        return Vec::new();
    }
    (0..count as usize)
        .filter_map(|index| {
            let item = unsafe { &*items.add(index) };
            (item.FmtValue.CStatus == 0).then(|| unsafe { (item.szName.to_string().unwrap_or_default(), item.FmtValue.Anonymous.doubleValue) })
        })
        .collect()
}

// "pid_1234_luid_0x00000000_0x0000D2F1_phys_0_eng_0_engtype_3D" -> (adapter luid, engine type)
fn engine(instance: &str) -> Option<(u64, &str)> {
    let (_, rest) = instance.split_once("luid_0x")?;
    let (high, rest) = rest.split_once("_0x")?;
    let (low, rest) = rest.split_once('_')?;
    let (_, kind) = rest.split_once("engtype_")?;
    Some(((u64::from_str_radix(high, 16).ok()? << 32) | u64::from_str_radix(low, 16).ok()?, kind))
}

fn round(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// averages since the previous call, every value null on the first one (rates need two collections). blocks some ms
pub fn sample() -> serde_json::Value {
    let mut counters = COUNTERS.lock().unwrap();
    if counters.is_none() {
        *counters = open();
    }
    let Some(counters) = counters.as_ref() else {
        return serde_json::Value::Null;
    };
    if unsafe { PdhCollectQueryData(PDH_HQUERY(counters.query as *mut _)) } != 0 {
        return serde_json::Value::Null;
    }

    // per adapter: the 3D engines of every process together, and the copy engines (a hybrid system copies each frame across)
    let mut gpus: BTreeMap<u64, (f64, f64)> = BTreeMap::new();
    for (instance, percent) in values(counters.gpu) {
        let Some((luid, kind)) = engine(&instance) else { continue };
        let entry = gpus.entry(luid).or_default();
        match kind {
            "3D" => entry.0 += percent,
            "Copy" => entry.1 += percent,
            _ => {}
        }
    }
    let gpu: serde_json::Map<String, serde_json::Value> = gpus
        .into_iter()
        .map(|(luid, (render, copy))| (format!("{luid:x}"), serde_json::json!({ "render": round(render), "copy": round(copy) })))
        .collect();
    let lowest = |counter| values(counter).into_iter().map(|(_, value)| value).reduce(f64::min);
    // tenths of a kelvin on some systems, kelvin on others
    let hottest = values(counters.temperature)
        .into_iter()
        .map(|(_, value)| if value > 1000.0 { value / 10.0 } else { value })
        .reduce(f64::max)
        .map(|kelvin| round(kelvin - 273.15));

    serde_json::json!({
        "cpuSpeed": value(counters.speed).map(round),
        "cpuBusy": value(counters.busy).map(round),
        "cpuLimit": value(counters.limit).map(round),
        "thermalLimit": lowest(counters.thermal).map(round),
        "temperature": hottest,
        "gpu": gpu,
        "nvidia": super::nvidia::telemetry(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_instance_names() {
        assert_eq!(engine("pid_1234_luid_0x00000000_0x0000D2F1_phys_0_eng_0_engtype_3D"), Some((0xd2f1, "3D")));
        assert_eq!(
            engine("pid_4_luid_0x00000001_0x0000D2F1_phys_0_eng_3_engtype_Copy"),
            Some((0x1_0000_d2f1, "Copy"))
        );
        assert_eq!(engine("_Total"), None);
    }
}
