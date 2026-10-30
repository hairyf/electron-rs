//! cargo run --manifest-path example/Cargo.toml --bin streaming
//! Run acquisition first. Electron main-thread scripts require a desktop/display.

use std::{path::Path, time::Duration};

use electron_rs::{electron_binary, CommandChunk, Electron};

fn show_output(chunk: CommandChunk) {
  eprint!("[{:?} #{}] {}", chunk.stream, chunk.sequence, String::from_utf8_lossy(&chunk.data));
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
  let binary = electron_binary!(None::<&Path>)?;
  let client = Electron::new(binary, 0).await?;
  // Node is a real standalone Node-mode process, not a Worker or an RPC.
  let node = client.node().args([
    "-e", "const {isMainThread,threadId}=require('node:worker_threads');console.log(JSON.stringify({pid:process.pid,isMainThread,threadId,nodeMode:process.env.ELECTRON_RUN_AS_NODE}));",
  ]).spawn()?;
  let main = client.run(r#"
    const { app } = require('electron');
    const { isMainThread, threadId } = require('node:worker_threads');
    for (let step = 1; step <= 3; step++) {
      console.log(`main: ${step}/3`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    console.error('main stderr');
    console.log(JSON.stringify({ pid: process.pid, isMainThread, threadId, ready: app.isReady() }));
    return 1n; // Ignored: only stdout/stderr are returned.
  "#).timeout(Duration::from_secs(10)).max_output_bytes(4096).on_output(show_output).await?;
  let node = node.wait_with_output().await?;
  assert!(node.status.success(), "node: {node:?}");
  assert!(main.status.success(), "main: {main:?}");
  let node_metadata: serde_json::Value = serde_json::from_slice(&node.stdout)?;
  let main_stdout = std::str::from_utf8(&main.stdout)?;
  let main_metadata: serde_json::Value = serde_json::from_str(main_stdout.lines().last().ok_or("missing main metadata")?)?;
  assert_eq!(node_metadata["isMainThread"], true);
  assert_eq!(node_metadata["threadId"], 0);
  assert_eq!(node_metadata["nodeMode"], "1");
  assert_eq!(main_metadata["isMainThread"], true);
  assert_eq!(main_metadata["threadId"], 0);
  assert_eq!(main_metadata["ready"], true);
  assert_ne!(node_metadata["pid"], main_metadata["pid"]);
  let failed = client.run("process.exitCode = 23").await?;
  assert_eq!(failed.status.code(), Some(23));
  let healthy = client.run("console.log(process.exitCode || 0)").await?;
  assert!(healthy.status.success(), "{healthy:?}");
  assert_eq!(healthy.stdout, b"0\n");
  let timed_out = client.run("await new Promise(() => {})").timeout(Duration::from_millis(50)).await?;
  assert_eq!(timed_out.status.code(), Some(124));
  println!("node metadata: {node_metadata}");
  println!("main metadata: {main_metadata}");
  client.shutdown();
  Ok(())
}
