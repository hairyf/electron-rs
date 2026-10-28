use std::path::Path;

use electron_rs::{arch, executable, platform};

fn main() {
  // Acquisition prepares this unbranded distribution separately; compiling
  // the examples only publishes its path, without downloading Electron.
  let binary = Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("target/electron")
    .join(format!("{}-{}", platform(), arch()))
    .join(executable());
  println!("cargo:rustc-env=APP_ELECTRON_BINARY={}", binary.display());
  println!("cargo:rerun-if-changed=build.rs");
}
