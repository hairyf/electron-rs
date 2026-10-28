# electron-rs

Build and control an Electron distribution from Rust, without Tauri.

- Acquire official Electron releases with SHA-256 verification and a shared cache.
- Stage a private distribution with bundled `main.cjs` and `preload.cjs`.
- Launch typed JSON-RPC, event subscriptions, and Node/Electron commands.

## Install

`electron-rs` is Git-only. Pin a revision or tag for release builds.

```toml
[dependencies]
electron-rs = { git = "https://github.com/hairyf/electron-rs.git" }
serde = { version = "1", features = ["derive"] }
tokio = { version = "1", features = ["rt", "time", "macros"] }

[build-dependencies]
electron-rs = { git = "https://github.com/hairyf/electron-rs.git" }
```

## Build

Prepare Electron in the consuming crate's `build.rs`:

```rust
use electron_rs::{ElectronBuilder, Error, DEFAULT_VERSION};

fn main() -> Result<(), Error> {
    let prepared = ElectronBuilder::new(DEFAULT_VERSION)
        .app_name("My App")
        .build()?;
    println!("cargo:rustc-env=APP_ELECTRON_BINARY={}", prepared.binary.display());
    Ok(())
}
```

`DEFAULT_VERSION` is `45.0.0`. `build()` returns a `PreparedDistribution` with absolute `directory` and `binary` paths. Bundle the complete `directory`, including libraries, resources, metadata, and scripts. The build step may use a local install/cache or download the official release; runtime discovery never downloads or repairs files. The `APP_ELECTRON_BINARY` path is suitable for local development; packaged apps should resolve the bundled resource root on the destination machine.

## Run

Start the prepared runtime from a Tokio runtime. `RpcRequest` types are application-defined:

```rust
use std::{error::Error, path::Path};
use electron_rs::{find_binary, Electron, RpcRequest};
use serde::Serialize;

#[derive(Serialize)]
struct SetTheme { theme: &'static str }

impl RpcRequest for SetTheme {
    type Response = ();
    const METHOD: &'static str = "app.theme";
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error>> {
    let binary = find_binary(Path::new(env!("APP_ELECTRON_BINARY")))?;
    let electron = Electron::new(binary, 0).await?;
    electron.call(SetTheme { theme: "system" }).await?;

    let node = electron.node(&["-p", "process.versions.node"])?;
    assert!(node.status.success());
    println!("{}", String::from_utf8_lossy(&node.stdout));

    electron.shutdown();
    Ok(())
}
```

`find_binary` accepts an executable, distribution directory, or resource root containing `<platform>-<arch>`. `Electron::new` launches the prepared bridge and requires the crate-owned scripts. `events()` takes the initial blocking receiver once; `on()` and `subscribe()` handle future events.

## Execute JavaScript and processes

The connected `electron` client supports four methods:

| Method | Execution context | Input | Output |
| --- | --- | --- | --- |
| `node_in_main(script, args)` | A short-lived Node Worker in the connected Electron process | Async JavaScript function body | Awaitable `Command` → `std::process::Output` |
| `electron_in_main(script, args)` | The connected Electron main thread, with access to its app and windows | Async JavaScript function body | Awaitable `Command` → `std::process::Output` |
| `node(args)` | A new process using the Electron binary in Node mode | CLI arguments | Blocking `io::Result<std::process::Output>` |
| `electron(args)` | A new process using the Electron binary in normal Electron mode | CLI arguments, such as an app path or `--version` | Blocking `io::Result<std::process::Output>` |

### `node_in_main`

Use Node APIs for filesystem work or computation in a Worker. It shares the Electron process PID, but has its own JavaScript context and cannot use Electron's main-thread APIs:

```rust
let output = electron
    .node_in_main("console.log(args[0]);", &["hello"])
    .timeout(std::time::Duration::from_secs(10))
    .await?;
assert!(output.status.success());
assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hello");
```

### `electron_in_main`

Use Electron APIs to inspect or control the existing app and its windows:

```rust
let output = electron.electron_in_main(
    r#"
    const { app, BrowserWindow } = require('electron');
    await app.whenReady();
    console.log(app.getName(), BrowserWindow.getAllWindows().length);
    "#,
    &[],
).await?;
assert!(output.status.success());
println!("{}", String::from_utf8_lossy(&output.stdout));
```

Both methods require the `Arc<Electron>` returned by `Electron::new(...).await`. Awaiting the `Command` starts execution on the current Tokio runtime. Bodies receive `args`, `signal`, CommonJS `require`, `process`, and `console`. All four methods return `std::process::Output` on success, with `status` and raw `stdout`/`stderr`; inspect `output.status.success()` or `output.status.code()`. Script return values are ignored, including BigInt and circular objects. Write data to stdout explicitly when needed. Use `.on_output(...)` for ordered byte chunks. Shared commands have no timeout by default; `.timeout(Duration)` adds an optional deadline, and `.max_output_bytes(...)` changes the default 16 MiB output cap. These are trusted Rust-side APIs; main-thread cancellation is cooperative and cannot interrupt synchronous JavaScript.

### `node`

Run Node CLI arguments with the prepared Electron binary by setting `ELECTRON_RUN_AS_NODE=1` in the child process:

```rust
let output = electron.node(&["-p", "process.versions.node"])?;
assert!(output.status.success());
println!("{}", String::from_utf8_lossy(&output.stdout));
```

### `electron`

Launch a separate Electron process, clearing `ELECTRON_RUN_AS_NODE` in the child environment:

```rust
let output = electron.electron(&["--version"])?;
assert!(output.status.success());
println!("{}", String::from_utf8_lossy(&output.stdout));
```

These two methods wait for the child to exit and capture its raw `stdout`/`stderr` and `status`. Nonzero exits are `Ok(Output)`; process launch or output collection failures return an I/O error. They do not connect the child to the existing RPC bridge. From async code, use `tokio::task::spawn_blocking` when the process may take time.

To run a process without starting a connected client, use `electron_rs::node(&binary, args)` / `electron_rs::electron(&binary, args)`, or `ElectronBuilder::node(args)` / `ElectronBuilder::electron(args)` after preparing its distribution.

## API

- `ElectronBuilder`: acquisition, output paths, search paths, resources, and branding metadata.
- `PreparedDistribution` and `find_binary`: resolve the exact staged paths to bundle or launch.
- `Electron`: typed `call`, events, subscriptions, shared-main commands, `node`, `electron`, and `shutdown`.
- `node(binary, args)` / `electron(binary, args)`: standalone process helpers; nonzero exits are `Ok(Output)`.
- `Metadata`: Windows `.ico`, macOS `.icns`, identifiers, and platform-specific app names.

See the [Rust source](src/lib.rs), [bundled bridge](assets/main.cjs), [examples](example/), and [integration tests](tests/).

## Examples

Run these from the repository root. Acquisition prepares the distribution used by the other examples:

```bash
cargo run --manifest-path example/Cargo.toml --bin acquisition
cargo run --manifest-path example/Cargo.toml --bin node-command
cargo run --manifest-path example/Cargo.toml --bin rpc
cargo run --manifest-path example/Cargo.toml --bin streaming
```

The RPC and streaming examples need a desktop; on Linux, use a display such as Xvfb.

## Development

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run build
pnpm test
```

CI runs on Windows, macOS, and Linux. The ignored [real bridge tests](tests/bridge.rs) require `pnpm run test:bridge:prepare` followed by `pnpm run test:bridge` with a desktop/display. Protocol and staging tests run without Electron.

Linux supports `app_name` branding only. Windows/macOS branding requires the matching host; sign and notarize afterward. Use separate output directories for concurrent builders, and package all runtime files beside the application.

The Tauri adapter lives in the separate [tauri-runtime-electron](https://github.com/hairyf/tauri-runtime-electron) project.

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE-2.0).
