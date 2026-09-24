// VERSIONINFO for the exe and both DLLs, include!d by their build scripts. all carry the client version

const COMPANY: &str = "NullDev e.U.";
#[allow(dead_code)]
const VFT_APP: &str = "0x1L";
#[allow(dead_code)]
const VFT_DLL: &str = "0x2L";

#[allow(dead_code)]
fn client_version(cargo_toml: &str) -> String {
    let content = std::fs::read_to_string(cargo_toml).unwrap();
    let toml: toml::Value = toml::from_str(&content).unwrap();
    toml["package"]["version"].as_str().unwrap().to_string()
}

fn embed_version_resource(version: &str, product: &str, description: &str, file_name: &str, file_type: &str) {
    // FILEVERSION needs four numbers
    let numbers = version
        .split(['.', '-', '+'])
        .map(|part| part.parse::<u16>().unwrap_or(0))
        .chain([0, 0, 0, 0])
        .take(4)
        .map(|number| number.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let internal_name = file_name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(file_name);
    let resource = format!(
        r#"#pragma code_page(65001)
1 VERSIONINFO
FILEVERSION {numbers}
PRODUCTVERSION {numbers}
FILEOS 0x40004L
FILETYPE {file_type}
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904b0"
        BEGIN
            VALUE "CompanyName", "{COMPANY}"
            VALUE "FileDescription", "{description}"
            VALUE "FileVersion", "{version}"
            VALUE "InternalName", "{internal_name}"
            VALUE "OriginalFilename", "{file_name}"
            VALUE "ProductName", "{product}"
            VALUE "ProductVersion", "{version}"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x409, 1200
    END
END
"#
    );

    // OUT_DIR so a bump doesn't dirty the tree
    let path = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("version.rc");
    std::fs::write(&path, resource).unwrap();
    embed_resource::compile(&path, embed_resource::NONE).manifest_optional().ok();
}
