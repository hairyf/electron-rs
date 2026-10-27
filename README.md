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

## Shared-main commands

Use `node_in_main` for a short-lived Node Worker or `electron_in_main` for the current Electron main thread:

```rust
let output = electron
    .node_in_main("return { answer: 42, arg: args[0] };", &["hello"])
    .timeout(std::time::Duration::from_secs(10))
    .await?;
assert_eq!(output.result["answer"], 42);
```

Bodies receive `args`, `signal`, CommonJS `require`, `process`, and `console`. `CommandOutput` keeps `code`, raw `stdout`/`stderr`, and the JSON `result` separate. Use `.on_output(...)` for ordered byte chunks and `.timeout(...)` / `.max_output_bytes(...)` for limits. Defaults are 30 seconds and 16 MiB; cancellation of main-thread JavaScript is cooperative.

These are trusted Rust-side execution APIs, not a JavaScript sandbox or renderer endpoint. Electron APIs require the process to have reached `app.whenReady()`.

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
