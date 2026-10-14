use flate2::{Compression, Crc, write::DeflateEncoder};
use std::io::Write;

// a plain zip without zip64: every entry and the whole file stay far below 4 GB

fn u16le(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn u32le(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// (year, month, day) as an MS-DOS date, 1980-01-01 for anything before
fn dos_date((year, month, day): (u32, u32, u32)) -> u16 {
    if year < 1980 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return (1 << 5) | 1;
    }
    (((year - 1980) << 9) | (month << 5) | day) as u16
}

pub fn write(entries: &[(String, Vec<u8>)], date: (u32, u32, u32)) -> Vec<u8> {
    let date = dos_date(date);
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let mut crc = Crc::new();
        crc.update(data);
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).ok();
        let compressed = encoder.finish().unwrap_or_default();
        let offset = out.len() as u32;

        // version 2.0, utf-8 names, deflate, time 00:00
        let header = |out: &mut Vec<u8>| {
            u16le(out, 20);
            u16le(out, 0x0800);
            u16le(out, 8);
            u16le(out, 0);
            u16le(out, date);
            u32le(out, crc.sum());
            u32le(out, compressed.len() as u32);
            u32le(out, data.len() as u32);
            u16le(out, name.len() as u16);
            u16le(out, 0);
        };

        u32le(&mut out, 0x0403_4b50);
        header(&mut out);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&compressed);

        u32le(&mut central, 0x0201_4b50);
        u16le(&mut central, 20);
        header(&mut central);
        // comment, disk, internal and external attributes
        u16le(&mut central, 0);
        u16le(&mut central, 0);
        u16le(&mut central, 0);
        u32le(&mut central, 0);
        u32le(&mut central, offset);
        central.extend_from_slice(name.as_bytes());
    }
    let central_offset = out.len() as u32;
    let central_size = central.len() as u32;
    out.extend_from_slice(&central);
    u32le(&mut out, 0x0605_4b50);
    u16le(&mut out, 0);
    u16le(&mut out, 0);
    u16le(&mut out, entries.len() as u16);
    u16le(&mut out, entries.len() as u16);
    u32le(&mut out, central_size);
    u32le(&mut out, central_offset);
    u16le(&mut out, 0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::DeflateDecoder;
    use std::io::Read;

    fn u32_at(data: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(data[at..at + 4].try_into().unwrap())
    }

    #[test]
    fn entries_round_trip_through_the_central_directory() {
        let entries = vec![
            ("a.txt".to_string(), b"hello hello hello".to_vec()),
            ("dir/b.bin".to_string(), vec![0u8, 1, 2, 255]),
        ];
        let zip = write(&entries, (2026, 10, 14));
        let end = zip.len() - 22;
        assert_eq!(u32_at(&zip, end), 0x0605_4b50);
        let mut at = u32_at(&zip, end + 16) as usize;
        for (name, data) in &entries {
            assert_eq!(u32_at(&zip, at), 0x0201_4b50);
            let compressed = u32_at(&zip, at + 20) as usize;
            let name_len = u16::from_le_bytes([zip[at + 28], zip[at + 29]]) as usize;
            let local = u32_at(&zip, at + 42) as usize;
            assert_eq!(&zip[at + 46..at + 46 + name_len], name.as_bytes());
            let start = local + 30 + name_len;
            let mut inflated = Vec::new();
            DeflateDecoder::new(&zip[start..start + compressed]).read_to_end(&mut inflated).unwrap();
            assert_eq!(&inflated, data);
            at += 46 + name_len;
        }
        assert_eq!(dos_date((2026, 10, 14)), ((46 << 9) | (10 << 5) | 14) as u16);
    }
}
