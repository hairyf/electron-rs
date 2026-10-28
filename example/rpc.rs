//! cargo run --manifest-path example/Cargo.toml --bin rpc
//! Run acquisition first. Real Electron requires a desktop/display (e.g. Xvfb on Linux).

use std::path::Path;

use electron_rs::{
  electron_binary, rpc::window::CursorPosition, Electron, SetTheme, Theme,
  DEFAULT_VERSION,
};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
  let binary = electron_binary!(None::<&Path>)?;
  let electron = Electron::new(binary, 0).await?;
  assert_eq!(electron.version, DEFAULT_VERSION);
  electron.call(SetTheme { theme: Theme::System }).await?;
  let position = electron.call(CursorPosition {}).await?;
  println!(
    "Electron {} cursor: ({}, {})",
    electron.version, position.x, position.y
  );
  electron.shutdown();
  Ok(())
}
