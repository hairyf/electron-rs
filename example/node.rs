//! cargo run --manifest-path example/Cargo.toml --bin node-command
//! Run acquisition first. Node mode needs no display and starts no RPC bridge.

use std::{
  io::{self, Write},
  path::Path,
};

use electron_rs::{arch, platform, ElectronBuilder, DEFAULT_VERSION};

fn main() -> Result<(), Box<dyn std::error::Error>> {
  let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("target/electron")
    .join(format!("{}-{}", platform(), arch()));
  let builder = ElectronBuilder::new(DEFAULT_VERSION).output(directory);
  let output = builder.node(&[
    "-e",
    r#"
    process.stdout.write(JSON.stringify({
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      answer: 6 * 7
    }) + '\n');
    process.stderr.write('real Node stderr\n');
  "#,
  ])?;
  io::stdout().write_all(&output.stdout)?;
  io::stderr().write_all(&output.stderr)?;
  eprintln!("status: {}", output.status);
  if !output.status.success() {
    return Err(format!("Node exited with {}", output.status).into());
  }
  let result: serde_json::Value = serde_json::from_slice(&output.stdout)?;
  assert_eq!(result["answer"], 42);
  assert_eq!(result["electron"], DEFAULT_VERSION);
  Ok(())
}
