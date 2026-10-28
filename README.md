# electron-rs

Build and control an Electron distribution from Rust, without Tauri.

- Acquire official Electron releases with SHA-256 verification and a shared cache
- Stage a private distribution with bundled `main.cjs` and `preload.cjs`
- Drive it with typed JSON-RPC, events, Node commands, and main-thread scripts

## Install

Git-only; pin a revision or tag for release builds.

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

`DEFAULT_VERSION` is `45.0.0`. `build()` returns a `PreparedDistribution` with absolute `directory` and `binary` paths — bundle the whole directory. Building may download the release or reuse a local cache; runtime discovery never downloads or repairs.

## Run

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

`electron_binary!(None)` reads the consuming crate's compile-time `APP_ELECTRON_BINARY`, normally set by its build script; a macro is required because a function cannot see a consumer's compile-time environment. `Some(path)` and `electron_binary(path)` take an executable, distribution directory, or resource root without it. Neither downloads, modifies, or reads the runtime environment.

`Electron::new` launches the bridge. `events()` takes the initial receiver once; `on()`/`subscribe()` cover later events. Built-in requests live in `electron_rs::rpc::{app, window, webview, protocol}`; implement `RpcRequest` only for extensions.

## JavaScript and processes

| API | Execution context | Input | Output |
| --- | --- | --- | --- |
| `client.node(args)` | Separate process, client's binary, `ELECTRON_RUN_AS_NODE=1` | Node CLI args | `io::Result<tokio::process::Child>` |
| `client.run(script)` | Connected main thread, with its app and windows | Async JS function body | Awaitable `Command` → `std::process::Output` |
| `node(binary, args)` | New process, Electron binary in Node mode | CLI args | `io::Result<tokio::process::Child>` |
| `electron(binary, args)` | New process, normal Electron mode | CLI args, e.g. an app path or `--version` | Blocking `io::Result<std::process::Output>` |

### Node mode

`client.node(args)` is `node(client.binary, args)`: `Command::spawn()` with `ELECTRON_RUN_AS_NODE=1`, null stdin, piped output, `kill_on_drop(true)` — no wrapper, RPC, or Worker. Needs a Tokio runtime with I/O enabled (`enable_all()` when manual).

```rust
let output = client.node(&["-p", "process.versions.node"])?
    .wait_with_output().await?;
assert!(output.status.success());
```

For live output and explicit cancellation, keep the native child:

```rust
use tokio::io::AsyncReadExt;

let mut child = client.node(&["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"])?;
let mut stdout = child.stdout.take().expect("piped stdout");
let mut ready = [0; 5];
stdout.read_exact(&mut ready).await?; // Arrives while the process is still running.
assert_eq!(&ready, b"ready");
child.kill().await?; // Terminates and waits for the direct child.
```

No timeout or buffering is imposed: pair `tokio::time::timeout` with `child.kill().await`, and drain both pipes (or `wait_with_output()`, which buffers). Kill-on-drop is not a process-tree manager.

> [!NOTE]
> With the `RunAsNode` fuse the child enters `NodeMain` without the browser stack, but still loads Electron's V8/ICU: native Node restrictions apply and memory parity with standalone Node is not guaranteed.

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

The body gets `signal`, `require`, `process`, and `console`, supports top-level `await`/`return`, and has no `args`. Returns are ignored; `process.exit` ends the task, not the host. No default deadline — `.timeout(...)`, `.max_output_bytes(...)` (16 MiB), and `.on_output(...)` are per call. Globals stay shared: a trusted Rust-side API, not a sandbox, whose cancellation cannot interrupt synchronous JavaScript.

`electron(binary, args)` is the blocking counterpart: clears `ELECTRON_RUN_AS_NODE`, waits, and returns `Output` (use `spawn_blocking` in async code). Neither connects to the RPC bridge; `ElectronBuilder::node`/`electron` wrap them for a prepared distribution.

## API

- `ElectronBuilder`, `Metadata`: acquisition, output paths, resources, `.ico`/`.icns` branding
- `PreparedDistribution`, `electron_binary!`/`electron_binary(path)`: the staged paths to bundle or launch
- `Electron`: typed `call`, events, subscriptions, `run(script)`, `node(args)`, `shutdown`

See the [Rust source](src/lib.rs), [bundled bridge](assets/main.cjs), [examples](example/), and [integration tests](tests/).

## Examples

From the repository root; acquisition prepares the distribution used by the others:

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

CI runs on Windows, macOS, and Linux. The ignored [real bridge tests](tests/bridge.rs) need `pnpm run test:bridge:prepare` and `pnpm run test:bridge` with a desktop/display. Linux supports `app_name` branding only; Windows/macOS branding needs the matching host, signed afterward.

The Tauri adapter lives in the separate [tauri-runtime-electron](https://github.com/hairyf/tauri-runtime-electron) project.

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE-2.0).
