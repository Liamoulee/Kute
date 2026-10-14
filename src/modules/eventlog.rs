use std::{
    collections::VecDeque,
    sync::{LazyLock, Mutex},
    time::Instant,
};

// release builds have no log at all (debug_print is verbose-logs only, cef logging is off), this is what a
// diagnostics report can still show. never push from a per-frame path
const CAPACITY: usize = 300;
const MAX_CHARS: usize = 400;

pub static START: LazyLock<Instant> = LazyLock::new(Instant::now);
static LINES: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

pub fn push(source: &str, text: &str) {
    let text = match text.char_indices().nth(MAX_CHARS) {
        Some((cut, _)) => format!("{}...", &text[..cut]),
        None => text.to_string(),
    };
    let line = format!("{:>9.1}s [{source}] {}", START.elapsed().as_secs_f64(), text.replace(['\r', '\n'], " "));
    let mut lines = LINES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if lines.len() == CAPACITY {
        lines.pop_front();
    }
    lines.push_back(line);
}

pub fn lines() -> Vec<String> {
    LINES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).iter().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newest_lines_and_cuts_long_ones() {
        for index in 0..CAPACITY + 5 {
            push("test", &format!("line {index}"));
        }
        push("test", &"x".repeat(MAX_CHARS + 10));
        let lines = lines();
        assert_eq!(lines.len(), CAPACITY);
        assert!(lines[0].ends_with("line 6"));
        assert!(lines.last().unwrap().ends_with(&format!("{}...", "x".repeat(MAX_CHARS))));
    }
}
