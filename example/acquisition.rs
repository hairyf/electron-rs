//! cargo run --manifest-path example/Cargo.toml --bin acquisition -- [existing-distribution]
//! Prepares real Electron and its RPC assets; downloads on cache miss. No display needed.

use std::path::Path;

use electron_rs::{arch, platform, ElectronBuilder, DEFAULT_VERSION};

fn main() -> Result<(), Box<dyn std::error::Error>> {
  let output = Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("target/electron")
    .join(format!("{}-{}", platform(), arch()));
  let mut builder = ElectronBuilder::new(DEFAULT_VERSION).output(output);
  if let Some(source) = std::env::args_os().nth(1) {
    builder = builder.path(source);
  }
  let prepared = builder.build()?;
  if let Some(warning) = &prepared.cleanup_warning {
    eprintln!("cleanup warning: {warning}");
  }
  assert!(prepared.binary.is_file());
  assert!(prepared.directory.join("main.cjs").is_file());
  println!("distribution: {}", prepared.directory.display());
  println!("binary: {}", prepared.binary.display());
  Ok(())
}
