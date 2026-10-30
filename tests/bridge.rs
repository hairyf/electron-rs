//! Real desktop bridge coverage, separate from the deterministic Node/VM tests.
//!
//! Run `prepare_bridge` first, then `real_bridge`, both with
//! `--ignored --exact --test-threads=1`. Preparation owns only
//! `target/electron-bridge`; on Linux, make its `<platform>-<arch>/chrome-sandbox`
//! root-owned and mode 4755 BETWEEN those commands. No sandbox-disabling flags.
//! This exercises a named subset, not every RPC or native desktop effect.
//! Metadata gives each preparation a unique profile; only staged output is
//! removed afterwards, not Electron's profile under the user's app-data root.

use std::{
  fs,
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::{
    mpsc::{self, Receiver, RecvTimeoutError},
    Arc,
  },
  thread,
  time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

mod support;

use electron_rs::{
  arch, electron_binary, platform, Electron, ElectronBuilder, Error, Metadata, RpcRequest,
  DEFAULT_VERSION,
};
use serde_json::{json, Value};

const WAIT: Duration = Duration::from_secs(20);
const WORKER: &str = "ELECTRON_RS_BRIDGE_TEST_WORKER";
const WINDOW: u32 = 41;
const MAIN: u32 = 71;
const CHILD: u32 = 72;
const PAGE: &str = r#"<!doctype html><html><head>
<meta charset="utf-8"><title>electron-rs bridge</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src ipc: http://ipc.localhost">
<link rel="icon" href="data:,"></head><body><p>real bridge</p><script>
(async () => {
  try {
    window.ipc.postMessage(JSON.stringify({kind: 'loaded', origin: location.origin,
      require: typeof require, process: typeof process}));
    const endpoint = location.protocol === 'http:' ? 'http://ipc.localhost' : 'ipc://localhost';
    const response = await fetch(endpoint + '/roundtrip?case=bytes', {
      method: 'POST', headers: {'content-type': 'application/octet-stream', 'x-bridge-test': 'request'},
      body: Uint8Array.of(0, 128, 255, 10),
    });
    window.bridgeResult = {kind: 'fetch', status: response.status,
      header: response.headers.get('x-bridge-test'),
      bytes: Array.from(new Uint8Array(await response.arrayBuffer()))};
    window.ipc.postMessage(JSON.stringify(window.bridgeResult));
  } catch (error) {
    window.ipc.postMessage(JSON.stringify({kind: 'error', message: String(error)}));
  }
})();
</script></body></html>"#;

fn repository() -> &'static Path {
  Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn stage_root() -> PathBuf {
  repository().join("target/electron-bridge")
}

fn distribution() -> PathBuf {
  stage_root().join(format!("{}-{}", platform(), arch()))
}

// The parent also bounds APIs such as node(), which have no timeout parameter.
// Inherit output: a Chromium descendant retaining a pipe must not hang the test.
fn in_worker(name: &str, timeout: Duration, keep_stage: bool) {
  let mut cleanup = RemoveDirectory(Some(stage_root()));
  let mut command = Command::new(std::env::current_exe().unwrap());
  command
    .args([
      name,
      "--ignored",
      "--exact",
      "--test-threads=1",
      "--nocapture",
    ])
    .env(WORKER, name)
    .env_remove("TAURI_RUNTIME_ELECTRON_OWNER")
    .stdout(Stdio::inherit())
    .stderr(Stdio::inherit());
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
  }
  let mut worker = Worker(command.spawn().expect("launch isolated bridge test worker"));
  let deadline = Instant::now() + timeout;
  let status = loop {
    match worker.0.try_wait().expect("poll bridge test worker") {
      Some(status) => break status,
      None if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
      None => panic!("{name} exceeded {timeout:?}"),
    }
  };
  assert!(status.success(), "{name} worker failed: {status}");
  if keep_stage {
    cleanup.0 = None;
  }
}

struct Worker(Child);

impl Drop for Worker {
  fn drop(&mut self) {
    #[cfg(windows)]
    if matches!(self.0.try_wait(), Ok(None)) {
      // Kill only this worker's descendants, never every Electron on the host.
      let _ = Command::new("taskkill")
        .args(["/F", "/T", "/PID", &self.0.id().to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    }
    #[cfg(windows)]
    {
      // A panicking worker may already have exited after reaping only the main
      // process. Match our unique image exactly, never a wildcard or stock app.
      let marker = fs::read(distribution().join("electron-rs.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
      if let Some(name) = marker.as_ref().and_then(|value| value["appName"].as_str()) {
        if name
          .strip_prefix("electron-rs-bridge-")
          .is_some_and(|suffix| {
            !suffix.is_empty()
              && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'-')
          })
        {
          let _ = Command::new("taskkill")
            .args(["/F", "/T", "/IM", &format!("{name}.exe")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        }
      }
    }
    #[cfg(unix)]
    {
      // A worker owns a fresh process group, including Electron's helpers.
      let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{}", self.0.id())])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    }
    let _ = self.0.kill();
    let _ = self.0.wait();
  }
}

struct RemoveDirectory(Option<PathBuf>);

impl Drop for RemoveDirectory {
  fn drop(&mut self) {
    let Some(path) = &self.0 else { return };
    // Only test-owned output is removable; never the cache or runtime root.
    assert!(path == &stage_root() || path == &stage_root().join("resources"));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
      match fs::remove_dir_all(path) {
        Ok(()) => break,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
        Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
        Err(error) if thread::panicking() => {
          eprintln!("clean {}: {error}", path.display());
          break;
        }
        Err(error) => panic!("clean {}: {error}", path.display()),
      }
    }
  }
}

struct Running(Arc<Electron>);

impl Drop for Running {
  fn drop(&mut self) {
    self.0.shutdown();
  }
}

#[test]
#[ignore = "stages real Electron; run explicitly before real_bridge and Linux sandbox setup"]
fn prepare_bridge() {
  if std::env::var(WORKER).as_deref() != Ok("prepare_bridge") {
    return in_worker("prepare_bridge", Duration::from_secs(300), true);
  }
  let unique = format!(
    "{}-{}",
    std::process::id(),
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap()
      .as_nanos()
  );
  let name = format!("electron-rs-bridge-{unique}");
  let metadata = Metadata {
    app_name: Some(name.clone()),
    // Linux supports executable renaming, not native identifier/icon branding.
    identifier: matches!(platform().as_str(), "win32" | "darwin")
      .then(|| format!("org.tauri.electron-rs-bridge-{unique}")),
    ..Metadata::default()
  };
  let runtime = repository().join("target/electron");
  let runtime_dist = runtime.join(format!("{}-{}", platform(), arch()));
  let snapshot = |root: &Path| {
    [
      "main.cjs",
      "preload.cjs",
      "electron-rs.json",
      ".electron-rs-version",
    ]
    .map(|name| fs::read(root.join(name)).ok())
  };
  let before = snapshot(&runtime_dist);
  let resources = stage_root().join("resources");
  let _resources_cleanup = RemoveDirectory(Some(resources.clone()));
  let source = ElectronBuilder::new(DEFAULT_VERSION)
    .path(&runtime)
    .output(resources.join(format!("{}-{}", platform(), arch())))
    .metadata(metadata.clone())
    .pe(true);
  let source = source
    .build()
    .expect("stage actual DEFAULT_VERSION from the runtime root/cache (or acquire it)");
  assert!(
    source.cleanup_warning.is_none(),
    "{:?}",
    source.cleanup_warning
  );
  fs::write(source.directory.join("bridge-resource-marker"), &name).unwrap();

  // The unique marker proves this resources mapping won over cache/local fallback.
  let builder = ElectronBuilder::new(DEFAULT_VERSION)
    .path(format!("{{resources}}/{}-{}", platform(), arch()))
    .resources_dir(&resources)
    .output(distribution())
    .metadata(metadata)
    .pe(true);
  let prepared = builder
    .build()
    .expect("copy the real prepared distribution through {resources}");
  assert!(
    prepared.cleanup_warning.is_none(),
    "{:?}",
    prepared.cleanup_warning
  );
  let directory = prepared.directory;
  let binary = prepared.binary;
  assert!(directory.is_absolute(), "{directory:?}");
  assert!(binary.is_absolute(), "{binary:?}");
  assert_eq!(directory, distribution());
  assert_eq!(builder.directory().unwrap(), directory);
  assert!(binary.starts_with(&directory));
  assert!(!directory.starts_with(&runtime) && !runtime.starts_with(&directory));
  assert_eq!(
    fs::read_to_string(directory.join("bridge-resource-marker")).unwrap(),
    name
  );
  for path in [directory.clone(), stage_root(), binary.clone()] {
    assert_eq!(
      fs::canonicalize(electron_binary(path).unwrap()).unwrap(),
      fs::canonicalize(&binary).unwrap()
    );
  }
  let relative = match platform().as_str() {
    "win32" => format!("{name}.exe"),
    "darwin" => format!("{name}.app/Contents/MacOS/{name}"),
    "linux" => name.clone(),
    other => panic!("real desktop bridge tests do not support {other}"),
  };
  assert_eq!(binary, directory.join(relative));
  let marker = fs::read(directory.join("electron-rs.json")).unwrap();
  let binary_bytes = fs::read(&binary).unwrap();
  fs::write(directory.join("main.cjs"), b"stale test asset").unwrap();
  fs::remove_file(directory.join("preload.cjs")).unwrap();
  let repaired = builder
    .build()
    .expect("repair assets by publishing a private copy");
  assert!(
    repaired.cleanup_warning.is_none(),
    "{:?}",
    repaired.cleanup_warning
  );
  assert_eq!(repaired.directory, directory);
  assert_eq!(repaired.binary, binary);
  assert_eq!(fs::read(&repaired.binary).unwrap(), binary_bytes);
  assert_eq!(
    fs::read(directory.join("main.cjs")).unwrap(),
    include_bytes!("../assets/main.cjs")
  );
  assert_eq!(
    fs::read(directory.join("preload.cjs")).unwrap(),
    include_bytes!("../assets/preload.cjs")
  );
  // Repair republishes the directory; only the following no-op must preserve times.
  let paths = [
    binary.clone(),
    directory.join("main.cjs"),
    directory.join("preload.cjs"),
  ];
  let modified = paths
    .each_ref()
    .map(|path| fs::metadata(path).unwrap().modified().unwrap());
  let repeated = builder.build().expect("repeat preparation idempotently");
  assert!(
    repeated.cleanup_warning.is_none(),
    "{:?}",
    repeated.cleanup_warning
  );
  assert_eq!(repeated.directory, directory);
  assert_eq!(repeated.binary, binary);
  assert_eq!(
    paths
      .each_ref()
      .map(|path| fs::metadata(path).unwrap().modified().unwrap()),
    modified
  );
  assert_eq!(fs::read(&repeated.binary).unwrap(), binary_bytes);
  assert_eq!(
    fs::read(directory.join("main.cjs")).unwrap(),
    include_bytes!("../assets/main.cjs")
  );
  assert_eq!(
    fs::read(directory.join("preload.cjs")).unwrap(),
    include_bytes!("../assets/preload.cjs")
  );
  assert_eq!(
    fs::read(directory.join("electron-rs.json")).unwrap(),
    marker
  );
  let output = block_on(async { builder.node().unwrap().args(["-e", "process.stdout.write(JSON.stringify({electron:process.versions.electron,platform:process.platform,arch:process.arch,answer:6*7}))"]).spawn().expect("run the staged real binary in Node mode").wait_with_output().await.unwrap() });
  assert!(output.status.success(), "{:?}", output);
  support::assert_node_stderr(&output.stderr, b"");
  let result: Value = serde_json::from_slice(&output.stdout).unwrap();
  assert_eq!(
    result,
    json!({"electron":DEFAULT_VERSION,"platform":platform(),"arch":arch(),"answer":42})
  );
  let failed = block_on(async { builder
    .node()
    .unwrap()
    .args([
      "-e",
      "process.stderr.write('bridge-node-error');process.exit(23)",
    ])
    .spawn()
    .expect("collect nonzero Node output").wait_with_output().await.unwrap() });
  assert_eq!(failed.status.code(), Some(23));
  assert!(failed.stdout.is_empty());
  support::assert_node_stderr(&failed.stderr, b"bridge-node-error");
  let silent = block_on(async { builder
    .node()
    .unwrap()
    .args(["-e", "process.exit(17)"])
    .spawn()
    .expect("collect silent Node failure").wait_with_output().await.unwrap() });
  assert_eq!(silent.status.code(), Some(17));
  assert!(silent.stdout.is_empty());
  support::assert_node_stderr(&silent.stderr, b"");
  assert_eq!(
    snapshot(&runtime_dist),
    before,
    "preparation must not mutate the root runtime distribution"
  );
  println!(
    "prepared real Electron {DEFAULT_VERSION}: {}",
    binary.display()
  );
}

fn receive(receiver: &Receiver<Value>, deadline: Instant, description: &str) -> Value {
  let event = receiver
    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
    .unwrap_or_else(|error| panic!("waiting for {description}: {error}"));
  assert_ne!(
    event["event"], "webview.processGone",
    "renderer crashed: {event}"
  );
  event
}

fn event_matching(
  receiver: &Receiver<Value>,
  description: &str,
  mut matches: impl FnMut(&Value) -> bool,
) -> Value {
  let deadline = Instant::now() + WAIT;
  loop {
    let event = receive(receiver, deadline, description);
    if matches(&event) {
      return event;
    }
    assert_ne!(
      event["event"], "ipc.closed",
      "Electron disconnected while waiting for {description}"
    );
  }
}

// Keep the real-desktop assertions synchronous, as in ipc.rs's transport tests.
fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
  tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .unwrap()
    .block_on(future)
}

fn real_commands(electron: &Arc<Electron>, binary: &Path) {
  use std::{future::IntoFuture as _, sync::atomic::{AtomicBool, Ordering}};
  use electron_rs::OutputStream;

  let general = electron.subscribe();
  let oracle = block_on(async { electron_rs::node(binary).args(["-e", "process.stdout.write(Buffer.from([0,128,255,10]));process.stderr.write(Buffer.from([255,0,65]));"]).spawn().expect("direct connected Node binary-output oracle").wait_with_output().await.unwrap() });
  assert!(oracle.status.success(), "{oracle:?}");
  support::assert_node_stderr(&oracle.stderr, &[255, 0, 65]);
  block_on(async {
    // Node forwards native CLI args to another PID; run keeps the existing main.
    let identity = "const {isMainThread,threadId}=require('node:worker_threads');console.log(JSON.stringify({pid:process.pid,isMainThread,threadId,electron:process.versions.electron,nodeMode:process.env.ELECTRON_RUN_AS_NODE}));";
    let node = electron.node().args(["-e", identity]).spawn().unwrap().wait_with_output().await.unwrap();
    assert!(node.status.success(), "{node:?}");
    support::assert_node_stderr(&node.stderr, b"");
    let node: Value = serde_json::from_slice(&node.stdout).unwrap();
    assert_eq!(node["isMainThread"], true);
    assert_eq!(node["threadId"], 0);
    assert_eq!(node["electron"], DEFAULT_VERSION);
    assert_eq!(node["nodeMode"], "1");
    let main = electron.run(
      "const {isMainThread,threadId}=require('node:worker_threads');console.log(JSON.stringify({pid:process.pid,isMainThread,threadId,ready:require('electron').app.isReady(),electron:process.versions.electron}));const ignored={};ignored.self=ignored;return ignored;",
    ).timeout(WAIT).await.unwrap();
    assert!(main.status.success(), "{main:?}");
    assert!(main.stderr.is_empty());
    let main: Value = serde_json::from_slice(&main.stdout).unwrap();
    assert!(main["pid"].as_u64().unwrap() > 0);
    assert_ne!(main["pid"], node["pid"]);
    assert_eq!(main["isMainThread"], true);
    assert_eq!(main["threadId"], 0);
    assert_eq!(main["ready"], true);
    assert_eq!(main["electron"], DEFAULT_VERSION);
    let version = electron_rs::electron(binary).args(["--version"]).output().await.unwrap();
    assert!(version.status.success(), "{version:?}");
    assert_eq!(String::from_utf8_lossy(&version.stdout).trim(), format!("v{DEFAULT_VERSION}"));
    let printed = electron.node().args(["-p", "6 * 7"]).spawn().unwrap().wait_with_output().await.unwrap();
    assert!(printed.status.success(), "{printed:?}");
    assert_eq!(printed.stdout, b"42\n");
    support::assert_node_stderr(&printed.stderr, b"");
    // Deliberately omit .timeout() and exceed normal RPC's 5s deadline.
    let output = tokio::time::timeout(WAIT, electron.run(
      "await new Promise(resolve=>setTimeout(resolve,5100));process.stdout.write('unlimited');return 1n;",
    )).await.unwrap().unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"unlimited");
    assert!(output.stderr.is_empty());
    let node = electron.node().args(["-e", "if(process.argv[1]!=='argument with spaces'||process.argv[2]!=='雪 🦀')throw new Error('arguments changed');process.stdout.write(Buffer.from([0,128,255,10]));process.stderr.write(Buffer.from([255,0,65]));", "--", "argument with spaces", "雪 🦀"]).spawn().unwrap().wait_with_output().await.unwrap();
    assert!(node.status.success(), "{node:?}");
    assert_eq!(node.stdout, oracle.stdout);
    support::assert_node_stderr(&node.stderr, &[255, 0, 65]);
    let output = electron.run("process.stdout.write(Buffer.from([0,128,255,10]));process.stderr.write(Buffer.from([255,0,65]));return 1n;")
      .timeout(WAIT).max_output_bytes(64).await.unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, oracle.stdout);
    assert_eq!(output.stderr, [255, 0, 65]);
    let failed = electron.node().args(["-e", "process.exit(17)"]).spawn().unwrap().wait_with_output().await.unwrap();
    assert_eq!(failed.status.code(), Some(17));
    assert!(failed.stdout.is_empty());
    support::assert_node_stderr(&failed.stderr, b"");
    let failed = electron.run("process.exitCode=23;return {scoped:true};")
      .timeout(WAIT).await.unwrap();
    assert_eq!(failed.status.code(), Some(23));

    let first = Arc::new(AtomicBool::new(false));
    let observed = Arc::clone(&first);
    let (chunks, received) = mpsc::channel();
    let mut pending = electron.run(
      "console.log('live stdout');console.error('live stderr');await new Promise(resolve=>setTimeout(resolve,1000));console.log('last stdout');console.error('last stderr');return {answer:42};",
    ).timeout(WAIT).max_output_bytes(1024).on_output(move |chunk| {
      chunks.send(chunk).unwrap();
      observed.store(true, Ordering::SeqCst);
    }).into_future();
    tokio::time::timeout(WAIT, async {
      tokio::select! {
        biased;
        result = &mut pending => panic!("command completed before live output was observed: {result:?}"),
        _ = async {
          while !first.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
          }
        } => {}
      }
    }).await.expect("first output must arrive while the script is delayed");
    let output = pending.await.unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"live stdout\nlast stdout\n");
    assert_eq!(output.stderr, b"live stderr\nlast stderr\n");
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    for (sequence, chunk) in received.try_iter().enumerate() {
      assert_eq!(chunk.sequence, sequence as u64);
      match chunk.stream {
        OutputStream::Stdout => stdout.extend(chunk.data),
        OutputStream::Stderr => stderr.extend(chunk.data),
      }
    }
    assert_eq!(stdout, output.stdout);
    assert_eq!(stderr, output.stderr);
    let timed_out = electron.run("await new Promise(()=>{});")
      .timeout(Duration::from_millis(100)).await.unwrap();
    assert_eq!(timed_out.status.code(), Some(124));
    let healthy = electron.run(
      "console.log(JSON.stringify({pid:process.pid,ready:require('electron').app.isReady(),code:process.exitCode??0}));",
    ).timeout(WAIT).await.unwrap();
    assert!(healthy.status.success(), "{healthy:?}");
    assert!(healthy.stderr.is_empty());
    let healthy: Value = serde_json::from_slice(&healthy.stdout).unwrap();
    assert_eq!(healthy, json!({"pid":main["pid"],"ready":true,"code":0}));
  });
  assert!(matches!(general.try_recv(), Err(mpsc::TryRecvError::Empty)),
    "command output must bypass general events");
}

struct Request {
  method: &'static str,
  params: Value,
}

impl serde::Serialize for Request {
  fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    serde::Serialize::serialize(&self.params, serializer)
  }
}

impl RpcRequest for Request {
  type Response = Value;
  const METHOD: &'static str = "bridge.test";

  fn method(&self) -> &'static str {
    self.method
  }

  fn timeout(&self) -> Duration {
    WAIT
  }
}

fn rpc(electron: &Electron, method: &'static str, params: Value) -> Result<Value, Error> {
  block_on(electron.call(Request { method, params }))
}

fn call(electron: &Electron, method: &'static str, params: Value) -> Value {
  rpc(electron, method, params).unwrap_or_else(|error| panic!("{method}: {error}"))
}

fn eval(electron: &Electron, webview: u32, script: &str) -> Value {
  call(
    electron,
    "webview.eval",
    json!({"webviewId":webview,"script":script}),
  )
}

fn geometry_matching(
  electron: &Electron,
  description: &str,
  matches: impl Fn(&Value) -> bool,
) -> Value {
  let deadline = Instant::now() + WAIT;
  loop {
    let geometry = call(electron, "window.geometry", json!({"windowId":WINDOW}));
    if matches(&geometry) {
      return geometry;
    }
    assert!(
      Instant::now() < deadline,
      "{description}: last geometry {geometry}"
    );
    thread::sleep(Duration::from_millis(20));
  }
}

#[test]
#[ignore = "requires real Electron preparation and a desktop"]
fn real_command_output() {
  if std::env::var(WORKER).as_deref() != Ok("real_command_output") {
    return in_worker("real_command_output", Duration::from_secs(60), false);
  }
  let binary = electron_binary(stage_root()).expect("run prepare_bridge first");
  let running = Running(block_on(Electron::new(&binary, 0)).expect("real Electron handshake"));
  real_commands(&running.0, &binary);
}

#[test]
#[ignore = "requires real Electron preparation and a desktop (Xvfb/X11 plus setuid sandbox on Linux)"]
fn real_bridge() {
  if std::env::var(WORKER).as_deref() != Ok("real_bridge") {
    return in_worker("real_bridge", Duration::from_secs(180), false);
  }
  let binary = electron_binary(stage_root())
    .expect("run prepare_bridge, then configure the staged Linux sandbox before real_bridge");
  let marker: Value =
    serde_json::from_slice(&fs::read(distribution().join("electron-rs.json")).unwrap()).unwrap();
  assert!(marker["appName"]
    .as_str()
    .unwrap()
    .starts_with("electron-rs-bridge-"));
  if cfg!(target_os = "linux") {
    assert!(
      marker["identifier"].is_null(),
      "Linux supports name-only branding"
    );
  } else {
    assert!(marker["identifier"]
      .as_str()
      .unwrap()
      .starts_with("org.tauri.electron-rs-bridge-"));
  }
  #[cfg(target_os = "linux")]
  {
    use std::os::unix::fs::MetadataExt;
    let sandbox = fs::metadata(distribution().join("chrome-sandbox")).unwrap();
    assert_eq!(
      sandbox.uid(),
      0,
      "chown root:root the staged chrome-sandbox after prepare_bridge"
    );
    assert_eq!(
      sandbox.gid(),
      0,
      "chown root:root the staged chrome-sandbox after prepare_bridge"
    );
    assert_eq!(
      sandbox.mode() & 0o7777,
      0o4755,
      "chmod 4755 the staged chrome-sandbox after prepare_bridge"
    );
  }
  let mut args = vec!["--tauri-schemes=bridge,ipc".to_string()];
  if cfg!(target_os = "linux") {
    // Native handle assertions below target X11, not Wayland's handle contract.
    args.push("--ozone-platform=x11".into());
  }
  let running = Running(
    block_on(Electron::with_args(&binary, 0, &args, WAIT)).expect("real Electron handshake"),
  );
  let electron = &running.0;
  assert_eq!(electron.version, DEFAULT_VERSION);
  let events = electron.events().unwrap();
  assert!(electron
    .events()
    .unwrap_err()
    .to_string()
    .contains("already taken"));
  let subscription = electron.subscribe();
  let (callback_tx, callback) = mpsc::channel();
  electron.on(move |event| {
    let _ = callback_tx.send(event);
  });
  real_commands(electron, &binary);
  let output = block_on(async { electron_rs::node(&binary).args(["-e", "process.stdout.write(JSON.stringify({electron:process.versions.electron,answer:21*2,page:Buffer.from(process.argv[1]).toString('base64')}))", PAGE]).spawn().unwrap().wait_with_output().await.unwrap() });
  assert!(output.status.success(), "{:?}", output);
  support::assert_node_stderr(&output.stderr, b"");
  let node: Value = serde_json::from_slice(&output.stdout).unwrap();
  assert_eq!(node["electron"], DEFAULT_VERSION);
  assert_eq!(node["answer"], 42);
  let failed = block_on(async { electron_rs::node(&binary)
    .args([
      "-e",
      "process.stderr.write('connected-node-error');process.exit(23)",
    ])
    .spawn()
    .expect("collect connected Node failure output").wait_with_output().await.unwrap() });
  assert_eq!(failed.status.code(), Some(23));
  assert!(failed.stdout.is_empty());
  support::assert_node_stderr(&failed.stderr, b"connected-node-error");
  let error = rpc(electron, "bridge.unknown", Value::Null).unwrap_err();
  assert!(
    matches!(&error, Error::Rpc { method, message }
      if method == "bridge.unknown" && message == "unknown method bridge.unknown"),
    "{error}"
  );
  for scheme in ["bridge", "ipc"] {
    assert_eq!(
      call(electron, "protocol.register", json!({"scheme":scheme})),
      Value::Null
    );
  }
  // Windows exercises the WebView2-style localhost mapping; macOS/Linux use
  // the privileged native custom scheme. Both must retain a non-opaque origin.
  let origin = if cfg!(windows) {
    "http://bridge.localhost"
  } else {
    "bridge://localhost"
  };
  let url = format!("{origin}/index.html");
  call(
    electron,
    "window.create",
    json!({
      "windowId":WINDOW,"title":"bridge initial","width":320,"height":240,"visible":false,
      "webview":{"webviewId":MAIN,"url":url}
    }),
  );
  let deadline = Instant::now() + WAIT;
  let (mut page_requests, mut ipc_requests) = (0, 0);
  let (mut loaded, mut posted, mut fetched) = (false, false, None);
  while !(loaded && posted && fetched.is_some()) {
    let event = receive(
      &events,
      deadline,
      "real page load, preload postMessage and binary IPC fetch",
    );
    let params = &event["params"];
    match event["event"].as_str() {
      Some("protocol.request") => match params["scheme"].as_str() {
        Some("bridge") => {
          page_requests += 1;
          assert_eq!(params["uri"], "bridge://localhost/index.html");
          assert_eq!(params["method"], "GET");
          call(
            electron,
            "protocol.respond",
            json!({"id":params["id"],"status":200,
            "headers":{"content-type":"text/html; charset=utf-8"},"body":node["page"]}),
          );
        }
        Some("ipc") => {
          ipc_requests += 1;
          assert_eq!(params["webviewId"], MAIN);
          assert_eq!(params["uri"], "ipc://localhost/roundtrip?case=bytes");
          assert_eq!(params["method"], "POST");
          assert_eq!(params["headers"]["origin"], origin);
          assert_eq!(params["headers"]["x-bridge-test"], "request");
          assert_eq!(params["body"], "AID/Cg==", "request bytes [0,128,255,10]");
          call(
            electron,
            "protocol.respond",
            json!({"id":params["id"],"status":201,
            "headers":{"content-type":"application/octet-stream","x-bridge-test":"response"},
            "body":"/wCAQQ=="}),
          ); // Response bytes [255,0,128,65].
        }
        _ => panic!("unexpected protocol request: {event}"),
      },
      Some("webview.loadFinished") if params["webviewId"] == MAIN => {
        assert_eq!(params["url"], url);
        loaded = true;
      }
      Some("ipc.message") => {
        assert_eq!(params["webviewId"], MAIN);
        assert_eq!(params["url"], url);
        let body: Value = serde_json::from_str(params["body"].as_str().unwrap()).unwrap();
        match body["kind"].as_str() {
          Some("loaded") => {
            assert_eq!(
              body,
              json!({"kind":"loaded","origin":origin,"require":"undefined","process":"undefined"})
            );
            posted = true;
          }
          Some("fetch") => {
            assert_eq!(
              body,
              json!({"kind":"fetch","status":201,"header":"response","bytes":[255,0,128,65]})
            );
            fetched = Some(event);
          }
          _ => panic!("page reported failure: {body}"),
        }
      }
      Some("ipc.closed") => panic!("Electron closed during page roundtrip"),
      _ => {}
    }
  }
  assert_eq!((page_requests, ipc_requests), (1, 1));
  let fetched = fetched.unwrap();
  for receiver in [&subscription, &callback] {
    assert_eq!(
      event_matching(receiver, "subscription/callback fetch event", |event| event
        == &fetched),
      fetched
    );
  }
  assert_eq!(
    eval(
      electron,
      MAIN,
      "({title:document.title,url:location.href,bytes:window.bridgeResult.bytes})"
    ),
    json!({"title":"electron-rs bridge","url":url,"bytes":[255,0,128,65]})
  );
  native_window_and_child(electron, &events);
  electron.shutdown();
  for receiver in [&events, &subscription, &callback] {
    event_matching(receiver, "shutdown closure notification", |event| {
      event["event"] == "ipc.closed"
    });
    assert!(matches!(
      receiver.recv_timeout(WAIT),
      Err(RecvTimeoutError::Disconnected)
    ));
  }
  assert!(matches!(
    electron.subscribe().recv_timeout(WAIT),
    Err(RecvTimeoutError::Disconnected)
  ));
  let error = rpc(electron, "window.geometry", json!({"windowId":WINDOW})).unwrap_err();
  assert!(matches!(error, Error::ChannelDisconnected), "{error}");
  electron.shutdown(); // Idempotent, including the guard's eventual shutdown.
  println!(
    "real Electron {DEFAULT_VERSION} bridge passed on {}-{}",
    platform(),
    arch()
  );
}

fn native_window_and_child(electron: &Electron, events: &Receiver<Value>) {
  call(
    electron,
    "window.setTitle",
    json!({"windowId":WINDOW,"title":"bridge native title"}),
  );
  geometry_matching(electron, "native title setter/getter", |geometry| {
    geometry["title"] == "bridge native title"
  });
  call(
    electron,
    "window.size",
    json!({"windowId":WINDOW,"width":420,"height":280,"physical":false}),
  );
  geometry_matching(
    electron,
    "native content size in physical pixels",
    |geometry| {
      let scale = geometry["scaleFactor"].as_f64().unwrap();
      geometry["contentBounds"]["width"] == (420.0 * scale).round() as u64
        && geometry["contentBounds"]["height"] == (280.0 * scale).round() as u64
    },
  );
  let handle = call(electron, "window.nativeHandle", json!({"windowId":WINDOW}));
  assert!(
    handle["handle"].as_u64().is_some_and(|value| value > 0),
    "expected HWND / NSView / X11 id: {handle}"
  );
  call(electron, "window.show", json!({"windowId":WINDOW}));
  geometry_matching(electron, "native window visibility", |geometry| {
    geometry["visible"] == true
  });
  call(
    electron,
    "webview.create",
    json!({"windowId":WINDOW,"webviewId":CHILD,
    "url":"data:text/html,<title>native-child</title><p>native child</p>",
    "bounds":{"position":{"x":11,"y":13},"size":{"width":180,"height":120}}}),
  );
  event_matching(events, "native child load", |event| {
    event["event"] == "webview.loadFinished" && event["params"]["webviewId"] == CHILD
  });
  assert_eq!(eval(electron, CHILD, "document.title"), "native-child");
  assert_eq!(
    eval(electron, MAIN, "document.title"),
    "electron-rs bridge",
    "child RPC must not target its parent's document"
  );
  call(
    electron,
    "webview.setBounds",
    json!({"webviewId":CHILD,
    "position":{"x":17,"y":19,"physical":false},"size":{"width":160,"height":100,"physical":false}}),
  );
  let bounds = call(electron, "webview.bounds", json!({"webviewId":CHILD}));
  let scale = bounds["scaleFactor"].as_f64().unwrap();
  assert_eq!(
    bounds["bounds"],
    json!({"x":(17.0*scale).round() as u64,"y":(19.0*scale).round() as u64,
    "width":(160.0*scale).round() as u64,"height":(100.0*scale).round() as u64})
  );
  for visible in [false, true] {
    call(
      electron,
      "webview.visibility",
      json!({"webviewId":CHILD,"visible":visible}),
    );
    assert_eq!(
      call(electron, "webview.bounds", json!({"webviewId":CHILD}))["visible"],
      visible
    );
  }
  call(electron, "webview.close", json!({"webviewId":CHILD}));
  assert!(rpc(
    electron,
    "webview.eval",
    json!({"webviewId":CHILD,"script":"1"})
  )
  .unwrap_err()
  .to_string()
  .contains("unknown webview"));
  call(electron, "window.hide", json!({"windowId":WINDOW}));
  geometry_matching(electron, "native hide", |geometry| {
    geometry["visible"] == false
  });
  call(electron, "window.close", json!({"windowId":WINDOW}));
  event_matching(events, "native close request", |event| {
    event["event"] == "window.closeRequested" && event["params"]["windowId"] == WINDOW
  });
  call(electron, "window.geometry", json!({"windowId":WINDOW})); // Close is host-vetoed until destroy.
  call(electron, "window.destroy", json!({"windowId":WINDOW}));
  event_matching(events, "native destruction", |event| {
    event["event"] == "window.closed" && event["params"]["windowId"] == WINDOW
  });
  assert!(rpc(electron, "window.geometry", json!({"windowId":WINDOW}))
    .unwrap_err()
    .to_string()
    .contains("unknown window"));
}
