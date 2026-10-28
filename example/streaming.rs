//! cargo run --manifest-path example/Cargo.toml --bin streaming
//! Run acquisition first. Real Electron requires a desktop/display (e.g. Xvfb on Linux).
//! The timeouts and output caps below are optional. Metadata is explicitly written to stdout.

use std::{path::Path, time::Duration};

use electron_rs::{electron_binary, CommandChunk, Electron};

fn show_output(chunk: CommandChunk) {
  // These scripts emit text; chunk.data itself preserves the original raw bytes.
  eprint!(
    "[{:?} #{}] {}",
    chunk.stream,
    chunk.sequence,
    String::from_utf8_lossy(&chunk.data)
  );
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
  let binary = electron_binary!(None::<&Path>)?;
  let electron = Electron::new(binary, 0).await?;

  let (worker, main) = tokio::join!(
    async {
      electron
        .node(&[
          "-e", r#"
         (async () => {
        const { isMainThread, threadId } = require('node:worker_threads');
        const { setTimeout: delay } = require('node:timers/promises');
        for (let step = 1; step <= 3; step++) {
          console.log(`worker ${process.argv[1]}: ${step}/3`);
          await delay(250);
        }
        console.error('worker stderr');
        console.log(JSON.stringify({ pid: process.pid, isMainThread, threadId }));
         })()
       "#, "--", "job",
        ])
        .timeout(Duration::from_secs(10))
        .max_output_bytes(4096)
        .on_output(show_output)
        .await
    },
    async {
      // Keep main-thread scripts asynchronous: synchronous CPU work blocks Electron.
      electron
        .electron(&[
          "-e", r#"
         (async () => {
        const { app } = require('electron');
        const { isMainThread, threadId } = require('node:worker_threads');
        for (let step = 1; step <= 3; step++) {
          console.log(`main ${process.argv[1]}: ${step}/3`);
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        console.error('main stderr');
        console.log(JSON.stringify({ pid: process.pid, isMainThread, threadId, ready: app.isReady() }));
         })()
       "#, "--", "job",
        ])
        .timeout(Duration::from_secs(10))
        .max_output_bytes(4096)
        .on_output(show_output)
        .await
    },
  );
  let worker = worker?;
  let main = main?;
  assert!(worker.status.success(), "worker: {worker:?}");
  assert!(main.status.success(), "main: {main:?}");
  let worker_stdout = std::str::from_utf8(&worker.stdout)?;
  let main_stdout = std::str::from_utf8(&main.stdout)?;
  let worker_metadata: serde_json::Value =
    serde_json::from_str(worker_stdout.lines().last().ok_or("missing worker metadata")?)?;
  let main_metadata: serde_json::Value =
    serde_json::from_str(main_stdout.lines().last().ok_or("missing main metadata")?)?;
  assert_eq!(worker_metadata["isMainThread"], false);
  assert_eq!(main_metadata["isMainThread"], true);
  assert_eq!(main_metadata["ready"], true);
  assert_eq!(worker_metadata["pid"], main_metadata["pid"]);
  let printed = electron.node(&["-p", "process.pid"]).await?;
  assert!(printed.status.success(), "{printed:?}");
  assert_eq!(std::str::from_utf8(&printed.stdout)?.trim().parse::<u64>()?, main_metadata["pid"]);
  let version = electron.electron(&["--version"]).await?;
  assert!(version.status.success(), "{version:?}");
  assert_eq!(std::str::from_utf8(&version.stdout)?.trim(), format!("v{}", electron.version));
  let failed = electron.electron(&["-e", "process.exitCode = 23"]).await?;
  assert_eq!(failed.status.code(), Some(23));
  let healthy = electron.electron(&["-p", "process.exitCode || 0"]).await?;
  assert!(healthy.status.success(), "{healthy:?}");
  assert_eq!(healthy.stdout, b"0\n");
  println!("worker metadata: {worker_metadata}");
  println!("main metadata: {main_metadata}");
  println!(
    "captured worker/main stdout: {}/{} bytes",
    worker.stdout.len(),
    main.stdout.len()
  );
  electron.shutdown();
  Ok(())
}
