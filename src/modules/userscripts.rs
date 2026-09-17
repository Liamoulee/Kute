use regex::Regex;
use std::{fs, sync::LazyLock};

use crate::utils;

static METADATA_REGEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?s)\A\s*\/\/ ==UserScript==.*?\/\/ ==\/UserScript=="#).unwrap());
static IIFE_REGEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?s)^\s*(?:['\"]use strict['\"];?\s*)?\(.*\)\s*\(\s*\)\s*;?\s*$"#).unwrap());

// TODO: everything
fn parse_metadata(content: &mut String) {
    if let Some(metadata_block) = METADATA_REGEX.find(content) {
        let metadata = metadata_block.as_str();
        if !metadata.contains("// @run-at document-start") {
            *content = format!("document.addEventListener('DOMContentLoaded', function() {{\n{}\n}});", content);
        }
    }
}

fn parse(mut content: String) -> String {
    if METADATA_REGEX.is_match(&content) {
        parse_metadata(&mut content);
    }

    // wrap it in an IIFE if it's not already
    if IIFE_REGEX.is_match(content.as_str()) {
        return content;
    }

    format!("(function() {{\n{}\n}})();", content)
}

// every parsed script of the (social) scripts folder, ready to run on document created
pub fn load(social: bool) -> Vec<String> {
    let scripts_dir = if social {
        utils::settings_dir().join("scripts").join("social")
    } else {
        utils::settings_dir().join("scripts")
    };

    let mut scripts = Vec::new();
    if let Ok(entries) = fs::read_dir(scripts_dir) {
        for entry in entries.flatten() {
            if !match entry.path().extension() {
                Some(ext) => ext.eq_ignore_ascii_case("js"),
                None => false,
            } {
                continue;
            }

            match fs::read_to_string(entry.path()) {
                Ok(content) => scripts.push(parse(content)),
                Err(e) => eprintln!("userscripts: can't read {}: {}", entry.path().display(), e),
            }
        }
    }

    scripts
}
