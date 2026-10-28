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

Start the prepared runtime from a Tokio runtime. Built-in requests and responses are provided by `electron_rs::rpc::{app, window, webview, protocol}`; `SetTheme` and `Theme` are also re-exported at the crate root. Consumers only implement `RpcRequest` for custom bridge extensions.

```rust
use std::{error::Error, path::Path};
use electron_rs::{electron_binary, Electron, SetTheme, Theme};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error>> {
    let binary = electron_binary!(None::<&Path>)?;
    let electron = Electron::new(binary, 0).await?;
    electron.call(SetTheme { theme: Theme::System }).await?;

    let output = electron.run("console.log(process.versions.node)").await?;
    assert!(output.status.success());
    println!("{}", String::from_utf8_lossy(&output.stdout));

    electron.shutdown();
    Ok(())
}
```

`electron_binary!(None::<&Path>)` uses the consuming crate's compile-time `APP_ELECTRON_BINARY`, usually set by its build script. This requires a macro: an ordinary library function cannot read a consumer's compile-time environment. A missing variable returns an error only for `None`; `electron_binary!(Some(path))` works without it. Explicit paths may also use the function `electron_binary(path)`. Both accept an executable, distribution directory, or resource root containing `<platform>-<arch>`, without downloading or modifying files. Runtime environment variables are not consulted.

`Electron::new` launches the prepared bridge and requires the crate-owned scripts. `events()` takes the initial blocking receiver once; `on()` and `subscribe()` handle future events.

## Execute JavaScript and processes

The client forwards Node CLI calls to its binary and runs scripts on its existing Electron main thread:

| API | Execution context | Input | Output |
| --- | --- | --- | --- |
| `client.node(args)` | A separate process using the client's binary with `ELECTRON_RUN_AS_NODE=1` | Native Node CLI arguments | Blocking `io::Result<std::process::Output>` |
| `client.run(script)` | The connected Electron main thread, with access to its app and windows | Async JavaScript function body | Awaitable `Command` → `std::process::Output` |
| `node(binary, args)` | A new process using the Electron binary in Node mode | CLI arguments | Blocking `io::Result<std::process::Output>` |
| `electron(binary, args)` | A new process using the Electron binary in normal Electron mode | CLI arguments, such as an app path or `--version` | Blocking `io::Result<std::process::Output>` |

### `client.node(args)`

This is a direct forwarder to `node(binary, args)` using the client's stored binary. It starts a new process with `ELECTRON_RUN_AS_NODE=1`, uses the native Node CLI, and does not send an RPC or create a Worker. It blocks until the child exits; from async code:

```rust
let node_client = client.clone();
let output = tokio::task::spawn_blocking(move || {
    node_client.node(&["-p", "process.versions.node"])
}).await??;
assert!(output.status.success());
```

With Electron's `RunAsNode` fuse enabled, this startup branch enters `NodeMain` instead of Chromium's `ContentMain`; it does not start the browser/renderer stack. It still uses Electron's executable, V8/ICU and platform startup components, so identical memory usage to standalone Node is not guaranteed. The crate does not emulate or filter Node's CLI; native Electron Node-mode restrictions still apply.

### `client.run(script)`

Run an async JavaScript function body on the existing Electron main thread, without CLI arguments:

```rust
let output = client.run(r#"
    const { app, BrowserWindow } = require('electron');
    await app.whenReady();
    console.log(app.getName(), BrowserWindow.getAllWindows().length);
    return 1n; // Ignored: use stdout for results.
"#)
.timeout(std::time::Duration::from_secs(10))
.on_output(|chunk| eprintln!("{:?}: {:?}", chunk.stream, chunk.data))
.await?;
assert!(output.status.success());
```

`run` requires the `Arc<Electron>` returned by `Electron::new(...).await`. Its body receives `signal`, CommonJS `require`, `process` and `console`, supports top-level `await` / `return`, and has no implicit `args`. Awaiting starts execution on the current Tokio runtime. Return values are ignored; output is process-style status plus raw stdout/stderr. `process.exit` ends the task rather than the Electron host. The awaited body defines task lifetime: detached timers are cleaned up when it finishes.

`run` has no deadline by default; `.timeout(Duration)` adds one, `.max_output_bytes(...)` changes the default 16 MiB output cap, and `.on_output(...)` receives ordered raw byte chunks before completion. Electron globals and module state remain shared. This is a trusted Rust-side API, not a security sandbox; cancellation is cooperative and cannot interrupt synchronous main-thread JavaScript. The Node forwarder is a normal blocking process helper, not a streaming `Command`.

### Standalone `node(binary, args)`

Run Node CLI arguments with the prepared Electron binary by setting `ELECTRON_RUN_AS_NODE=1` in the child process:

```rust
use std::path::Path;
use electron_rs::{electron_binary, node};

let output = node(electron_binary!(None::<&Path>)?, &["-p", "process.versions.node"])?;
assert!(output.status.success());
println!("{}", String::from_utf8_lossy(&output.stdout));
```

### Standalone `electron(binary, args)`

Launch a separate Electron process, clearing `ELECTRON_RUN_AS_NODE` in the child environment:

```rust
use std::path::Path;
use electron_rs::{electron_binary, electron};

let output = electron(electron_binary!(None::<&Path>)?, &["--version"])?;
assert!(output.status.success());
println!("{}", String::from_utf8_lossy(&output.stdout));
```

These two functions wait for the child to exit and capture its raw `stdout`/`stderr` and `status`. Nonzero exits are `Ok(Output)`; process launch or output collection failures return an I/O error. They do not connect the child to the existing RPC bridge. From async code, use `tokio::task::spawn_blocking` when the process may take time.

These standalone functions need no connected client. `ElectronBuilder::node(args)` / `ElectronBuilder::electron(args)` remain convenience methods for the builder's prepared distribution.

## API

- `ElectronBuilder`: acquisition, output paths, search paths, resources, and branding metadata.
- `PreparedDistribution` and `electron_binary!` / `electron_binary(path)`: resolve the exact staged paths to bundle or launch.
- `rpc::{app, window, webview, protocol}`: built-in request and response types; `RpcRequest` remains available for extensions.
- `Electron`: typed `call`, events, subscriptions, main-thread `run(script)`, Node-process `node(args)` forwarding, and `shutdown`.
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
