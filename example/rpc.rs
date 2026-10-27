//! cargo run --manifest-path example/Cargo.toml --bin rpc
//! Run acquisition first. Real Electron requires a desktop/display (e.g. Xvfb on Linux).

use std::path::Path;

use electron_rs::{arch, platform, Electron, ElectronBuilder, RpcRequest, DEFAULT_VERSION};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct CursorPositionRequest {}

#[derive(Deserialize)]
struct CursorPosition {
  x: i32,
  y: i32,
}

impl RpcRequest for CursorPositionRequest {
  type Response = CursorPosition;
  const METHOD: &'static str = "window.cursorPosition";
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
  let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("target/electron")
    .join(format!("{}-{}", platform(), arch()));
  let binary = ElectronBuilder::new(DEFAULT_VERSION)
    .output(directory)
    .binary()?;
  let electron = Electron::new(binary, 0).await?;
  assert_eq!(electron.version, DEFAULT_VERSION);
  let position = electron.call(CursorPositionRequest {}).await?;
  println!(
    "Electron {} cursor: ({}, {})",
    electron.version, position.x, position.y
  );
  electron.shutdown();
  Ok(())
}
