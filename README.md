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

    let output = electron.node(&["-p", "process.versions.node"]).await?;
    assert!(output.status.success());
    println!("{}", String::from_utf8_lossy(&output.stdout));

    electron.shutdown();
    Ok(())
}
```

`electron_binary!(None::<&Path>)` uses the consuming crate's compile-time `APP_ELECTRON_BINARY`, usually set by its build script. This requires a macro: an ordinary library function cannot read a consumer's compile-time environment. A missing variable returns an error only for `None`; `electron_binary!(Some(path))` works without it. Explicit paths may also use the function `electron_binary(path)`. Both accept an executable, distribution directory, or resource root containing `<platform>-<arch>`, without downloading or modifying files. Runtime environment variables are not consulted.

`Electron::new` launches the prepared bridge and requires the crate-owned scripts. `events()` takes the initial blocking receiver once; `on()` and `subscribe()` handle future events.

## Execute JavaScript and processes

The client has two shared-process methods; standalone processes use root-level functions:

| API | Execution context | Input | Output |
| --- | --- | --- | --- |
| `client.node(args)` | A short-lived Node Worker with the connected Electron process PID | CLI arguments | Awaitable `Command` → `std::process::Output` |
| `client.electron(args)` | The connected Electron main thread, with access to its app and windows | CLI arguments | Awaitable `Command` → `std::process::Output` |
| `node(binary, args)` | A new process using the Electron binary in Node mode | CLI arguments | Blocking `io::Result<std::process::Output>` |
| `electron(binary, args)` | A new process using the Electron binary in normal Electron mode | CLI arguments, such as an app path or `--version` | Blocking `io::Result<std::process::Output>` |

### `node`

Use Node APIs for filesystem work or computation in a Worker. It shares the Electron process PID, but has its own JavaScript context and cannot use Electron's main-thread APIs:

```rust
let output = electron
    .node(&["-e", "console.log(process.argv[1]);", "--", "hello"])
    .timeout(std::time::Duration::from_secs(10))
    .await?;
assert!(output.status.success());
assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hello");
```

### `electron`

Use Electron APIs to inspect or control the existing app and its windows:

```rust
let output = electron.electron(&[
    "-e", r#"
    (async () => {
        const { app, BrowserWindow } = require('electron');
        await app.whenReady();
        console.log(app.getName(), BrowserWindow.getAllWindows().length);
    })()
    "#,
]).await?;
assert!(output.status.success());
println!("{}", String::from_utf8_lossy(&output.stdout));
```

Both methods require the `Arc<Electron>` returned by `Electron::new(...).await`. Awaiting the `Command` starts execution on the current Tokio runtime. They accept CLI arguments, not an async function body or a separate script parameter:

- `-e` / `--eval` evaluates JavaScript; `-p` / `--print` prints its result. Use an async IIFE for asynchronous source; top-level `await` / `return` are not supported in CommonJS eval.
- `-v` / `--version` prints the Node version in Node mode or the Electron version in Electron mode.
- A CommonJS file or package directory runs its entry module with relative `require`, `__filename` and `__dirname`. Use `--` before a dash-prefixed entry/argument. Eval arguments start at `process.argv[1]`; file arguments start at `process.argv[2]`.
- ESM entries, REPL/stdin and startup-only V8/Node/Chromium switches are unsupported and return an explicit error. Use standalone functions when a fresh process or full native CLI behavior is required.

The same PID constraint means this is **not a restart or a fully equivalent CLI process**: Electron main-thread globals, module dependencies and app lifecycle remain shared. Normal task-owned asynchronous work is drained before completion; `process.exit` ends the command rather than the host. An eval's returned Promise is awaited, unlike a native CLI's unreferenced pending Promise. No implicit `args` or `signal` variables are injected.

All four APIs return `std::process::Output` with `status` and raw `stdout`/`stderr`; inspect `output.status.success()` or `output.status.code()`. Use `.on_output(...)` for ordered byte chunks. Shared commands have no timeout by default; `.timeout(Duration)` adds an optional deadline, and `.max_output_bytes(...)` changes the default 16 MiB output cap. These are trusted Rust-side APIs, not a security sandbox; main-thread cancellation is cooperative and cannot interrupt synchronous JavaScript.

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
- `Electron`: typed `call`, events, subscriptions, shared-main `node` / `electron` commands, and `shutdown`.
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
