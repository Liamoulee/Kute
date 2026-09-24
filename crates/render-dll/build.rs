extern crate embed_resource;
extern crate toml;

include!("../../resources/version_resource.rs");

// ships with the client, so it gets the client's version
fn main() {
    let version = client_version("../../Cargo.toml");
    embed_version_resource(
        &version,
        "Kute",
        "Kute render hook: the FPS limiter, the frame stats and the OBS capture producer",
        "render.dll",
        VFT_DLL,
    );

    println!("cargo:rerun-if-changed=../../Cargo.toml");
    println!("cargo:rerun-if-changed=../../resources/version_resource.rs");
}
