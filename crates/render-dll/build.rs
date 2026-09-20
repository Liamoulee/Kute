extern crate embed_resource;
extern crate toml;

include!("../../resources/version_resource.rs");

// it ships with the client, so it carries the client's version, not this crate's
fn main() {
    let version = client_version("../../Cargo.toml");
    embed_version_resource(&version, "Kute", "Kute render hook: the FPS limiter, the frame stats and the OBS capture producer", "render.dll", VFT_DLL);

    println!("cargo:rerun-if-changed=../../Cargo.toml");
    println!("cargo:rerun-if-changed=../../resources/version_resource.rs");
}
