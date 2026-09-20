use std::{env, fs, path::PathBuf};
extern crate embed_resource;
extern crate toml;

// what Explorer, the task manager and the signature dialog show about kute.exe. The version comes from
// Cargo.toml, so the release workflow's bump carries it without anyone editing a resource file
fn version_resource(package_version: &str, description: &str) -> String {
    // FILEVERSION wants four numbers, "0.1.8" is three
    let numbers = package_version
        .split(['.', '-', '+'])
        .map(|part| part.parse::<u16>().unwrap_or(0))
        .chain([0, 0, 0, 0])
        .take(4)
        .map(|number| number.to_string())
        .collect::<Vec<_>>()
        .join(",");

    format!(
        r#"#pragma code_page(65001)
1 VERSIONINFO
FILEVERSION {numbers}
PRODUCTVERSION {numbers}
FILEOS 0x40004L
FILETYPE 0x1L
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904b0"
        BEGIN
            VALUE "CompanyName", "NullDev e.U."
            VALUE "FileDescription", "{description}"
            VALUE "FileVersion", "{package_version}"
            VALUE "InternalName", "kute"
            VALUE "OriginalFilename", "kute.exe"
            VALUE "ProductName", "Kute"
            VALUE "ProductVersion", "{package_version}"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x409, 1200
    END
END
"#
    )
}

fn main() {
    embed_resource::compile("./resources/client.rc", embed_resource::NONE).manifest_optional().ok();
    if let Err(e) = embed_resource::compile("./resources/kute-manifest.rc", embed_resource::NONE).manifest_required() {
        eprintln!("{}", e)
    };

    let toml_content = fs::read_to_string("Cargo.toml").unwrap();
    let toml: toml::Value = toml::from_str(&toml_content).unwrap();
    let package_version = toml["package"]["version"].as_str().unwrap();
    let js_bundle_version = toml["package"]["metadata"]["js_bundle_version"].as_str().unwrap();
    let description = toml["package"]["description"].as_str().unwrap();

    // written into OUT_DIR instead of resources/, so a version bump never shows up as a changed file
    let version_rc = PathBuf::from(env::var("OUT_DIR").unwrap()).join("version.rc");
    fs::write(&version_rc, version_resource(package_version, description)).unwrap();
    embed_resource::compile(&version_rc, embed_resource::NONE).manifest_optional().ok();

    let dest_path = env::current_dir().unwrap().join("target/bundle_version");
    fs::write(dest_path, js_bundle_version).unwrap();

    let wxs_path = "resources/installer_script.wxs";
    let wxs_content = fs::read_to_string(wxs_path).unwrap();
    let regex = regex::Regex::new(r#"Version="([^"]+)""#).unwrap();

    let current_version = regex.captures(&wxs_content).and_then(|cap| cap.get(1)).map(|m| m.as_str());

    if current_version != Some(package_version) {
        let updated_wxs = regex.replace(&wxs_content, format!(r#"Version="{}""#, package_version)).to_string();
        fs::write(wxs_path, updated_wxs).unwrap();
    }

    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=resources/kute.exe.manifest");
    println!("cargo:rerun-if-changed=resources/kute-manifest.rc");
    println!("cargo:rerun-if-changed=resources/client.rc");
    // client.rc only names the icon, cargo has to be told that the file itself matters
    println!("cargo:rerun-if-changed=resources/kute.ico");
    println!("cargo:rerun-if-changed=resources/installer_script.wxs");
    println!("cargo:rerun-if-changed=target/bundle.js");
}
