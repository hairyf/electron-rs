//! cargo run --manifest-path example/Cargo.toml --bin node-command
//! Run acquisition first. Node mode needs no display and starts no RPC bridge.

use std::{
  io::{self, Write},
  path::Path,
};

use electron_rs::{electron_binary, node, DEFAULT_VERSION};

fn main() -> Result<(), Box<dyn std::error::Error>> {
  let output = node(electron_binary!(None::<&Path>)?, &[
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

#[test]
fn default_binary_uses_the_consumers_build_script() {
  let explicit = electron_binary(Path::new(env!("APP_ELECTRON_BINARY")));
  let default = electron_binary!(None::<&Path>);
  assert_eq!(
    default.map_err(|error| error.to_string()),
    explicit.map_err(|error| error.to_string()),
  );
}
