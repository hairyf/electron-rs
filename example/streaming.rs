//! cargo run --manifest-path example/Cargo.toml --bin streaming
//! Run acquisition first. Real Electron requires a desktop/display (e.g. Xvfb on Linux).
//! The timeouts and output caps below are optional. Metadata is explicitly written to stdout.

use std::{path::Path, time::Duration};

use electron_rs::{arch, platform, CommandChunk, Electron, ElectronBuilder, DEFAULT_VERSION};

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
  let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("target/electron")
    .join(format!("{}-{}", platform(), arch()));
  let binary = ElectronBuilder::new(DEFAULT_VERSION)
    .output(directory)
    .binary()?;
  let electron = Electron::new(binary, 0).await?;

  let (worker, main) = tokio::join!(
    async {
      electron
        .node_in_main(
          r#"
        const { isMainThread, threadId } = require('node:worker_threads');
        const { setTimeout: delay } = require('node:timers/promises');
        for (let step = 1; step <= 3; step++) {
          console.log(`worker ${args[0]}: ${step}/3`);
          await delay(250, undefined, { signal });
        }
        console.error('worker stderr');
        console.log(JSON.stringify({ pid: process.pid, isMainThread, threadId }));
      "#,
          &["job"],
        )
        .timeout(Duration::from_secs(10))
        .max_output_bytes(4096)
        .on_output(show_output)
        .await
    },
    async {
      // Keep main-thread scripts asynchronous: synchronous CPU work blocks Electron.
      electron
        .electron_in_main(
          r#"
        const { app } = require('electron');
        const { isMainThread, threadId } = require('node:worker_threads');
        for (let step = 1; step <= 3; step++) {
          console.log(`main ${args[0]}: ${step}/3`);
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        console.error('main stderr');
        console.log(JSON.stringify({ pid: process.pid, isMainThread, threadId, ready: app.isReady() }));
      "#,
          &["job"],
        )
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
