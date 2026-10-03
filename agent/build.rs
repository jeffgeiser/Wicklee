// RustEmbed's `#[folder = "frontend/dist"]` requires the directory to exist at
// compile time. Create an empty one when missing so `cargo check/clippy/test`
// work on a clean checkout without building the frontend first. Release
// builds run the frontend build beforehand, so the real assets are embedded.
fn main() {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("frontend/dist");
    if !dist.exists() {
        let _ = std::fs::create_dir_all(&dist);
    }
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=frontend/dist");
}
