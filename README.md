# electron-rs

Build and control an Electron distribution from Rust, without Tauri.

- Acquire official Electron releases with SHA-256 verification and a shared cache
- Stage a private distribution with bundled `main.cjs` and `preload.cjs`
- Drive it with typed JSON-RPC, events, Node commands, and main-thread scripts

## Browser guests

Set the trusted webview creation config’s `browserHost` to `true`, then call `rpc::browser::Acquire { webview_id, workspace }` and `Release { webview_id, lease }`. Reservations contain `lease` and a process-local, nonpersistent `partition`. Attach one `<webview partition="..." src="about:blank#LEASE" allowpopups>` per reservation; approved popup URLs arrive as `browser.openRequested { webviewId, lease, url }`. Browser guests have no preload or runtime IPC identity, deny permissions/downloads/native popups, and block application-host and privileged-scheme requests. Owners must be top-level `WebContentsView` pages: Electron does not register recursive `<webview>` elements in adopted guests, even with `webviewTag` enabled.

Run `pnpm run build && pnpm run test:browser` for the isolated real-Electron regression (Linux requires a graphical session/Xvfb and the normal Electron sandbox setup).

## Authenticated web hosts

Create a webview with `authenticatedWebHostSession: true` before loading its local bootstrap document. Call `rpc::protocol::AuthenticateHost { url }` with the owned backend launch URL, then `BindHost { webview_id, host_id }` before navigating to the returned `document_url`. Authentication requires a 303 and Set-Cookie; registration returns only an opaque id and token-free URLs. Trusted Rust hosts may explicitly call `rpc::protocol::HostCookieHeader { host_id }` to reuse the same credential for backend HTTP clients or event streams; never expose this value to renderer commands or logs, and send it only to `backend_origin`. Each host webview uses a private, nonpersistent session. Exact backend HTTP requests stream through main-process fetch/Response; HTTP/WS headers are scoped to the bound webContents and backend origin. Unrelated guests never inherit this session; native popups requiring the authenticated opener session are rejected. `rpc::browser::SetTrustedOrigin { webview_id, origin }` revokes the local authenticated binding, closes the old browser leases, and selects a new HTTP(S) document origin or restores the webview’s original registered custom-protocol origin before host-controlled navigation. Other custom origins, opaque origins, credentials, paths, queries, and fragments are rejected. Bind the authenticated host again to return to it. `rpc::browser::SetTrustedOriginAndNavigate { webview_id, origin, url }` instead keeps the old document authenticated until the exact target main frame commits. It closes browser leases before navigating and rejects new leases, concurrent trust changes, redirects and same-document transitions while pending. An uncommitted cancellation preserves the old binding; a committed transition never restores it. Its response means trust committed, not that the target finished loading.

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

- `DEFAULT_VERSION` is `45.0.0`
- `build()` returns a `PreparedDistribution` with absolute `directory` and `binary` paths — bundle the whole directory
- building may download the release or reuse a local cache; runtime discovery never downloads or repairs
- native branding defaults to **off in development** (`PROFILE=debug`) and **on in production** (`PROFILE=release`), using the consuming Cargo build script's profile, not the build dependency's optimization level; outside build scripts it follows `!cfg!(debug_assertions)`
- `.pe(true)` / `.pe(false)` explicitly overrides that default, regardless of metadata setter order; `false` disables executable/bundle renaming and native metadata/PE edits, and keeps the stock Electron executable. Icon and host-executable inputs are unused in that mode
- **runtime behavior is unchanged**: `app_name` and `identifier` stay in the distribution marker and continue to drive the runtime name, identifier and profile ownership; bridge assets and distribution/version markers are still prepared
- a previous branded output is replaced from a compatible stock source/cache, never renamed back or silently reused. Calling `binary()` with `.pe(false)` on a stale branded output fails until `build()` prepares it again

```rust
let prepared = ElectronBuilder::new(DEFAULT_VERSION)
    .app_name("My App")
    .pe(false) // Always use stock Electron, including release builds.
    .build()?;
```

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

- `electron_binary!(None)` reads the calling crate's compile-time `APP_ELECTRON_BINARY`, normally from its build script; the macro is required because a function cannot see a consumer's compile-time environment
- `Some(path)` and `electron_binary(path)` take an executable, distribution directory, or resource root, without that variable and without downloading or reading the runtime environment
- `Electron::new` launches the bridge; `events()` yields the initial receiver once, `on()`/`subscribe()` cover later events
- built-in requests live in `electron_rs::rpc::{app, window, webview, protocol}`; implement `RpcRequest` only for extensions

## JavaScript and processes

Startup initializes Electron before queuing the single authenticated ready frame. The socket worker connects only after that frame is queued, so the host’s 500 ms authentication deadline does not depend on another main-thread event-loop turn.

Webview script evaluation waits for the current main document’s `dom-ready`, not for unrelated images or frames to finish loading. A cross-document navigation rejects pending evaluations from the previous document; same-document navigation preserves them. A denied navigation that retains the previous document restores its readiness when the attempt stops. Concurrent evaluations share readiness listeners, and closing the webview rejects any waiters.

| API | Execution context | Input | Output |
| --- | --- | --- | --- |
| `client.node(args)` | Separate process, client's binary, `ELECTRON_RUN_AS_NODE=1` | Node CLI args | `io::Result<tokio::process::Child>` |
| `client.run(script)` | Connected main thread, with its app and windows | Async JS function body | Awaitable `Command` → `std::process::Output` |
| `node(binary, args)` | New process, Electron binary in Node mode | CLI args | `io::Result<tokio::process::Child>` |
| `electron(binary, args)` | New process, normal Electron mode | CLI args, e.g. an app path or `--version` | Blocking `io::Result<std::process::Output>` |

### Node mode

`client.node()` is `node(client.binary)`, a `tokio::process::Command` you chain arguments onto and spawn:

```rust
let output = client.node().args(["-p", "process.versions.node"])
    .spawn()?.wait_with_output().await?;
assert!(output.status.success());
```

Live output and explicit cancellation, from the native child:

```rust
use tokio::io::AsyncReadExt;

let mut child = client.node().args(["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"]).spawn()?;
let mut stdout = child.stdout.take().expect("piped stdout");
let mut ready = [0; 5];
stdout.read_exact(&mut ready).await?; // Arrives while the process is still running.
assert_eq!(&ready, b"ready");
child.kill().await?;
```

- plain Tokio `Command::spawn()` with `ELECTRON_RUN_AS_NODE=1`, null stdin, piped output, `kill_on_drop(true)` — no wrapper, RPC, or Worker; needs a Tokio runtime with I/O enabled (`enable_all()` when manual)
- no timeout or buffering imposed: pair `tokio::time::timeout` with `child.kill().await`, drain both pipes (or `wait_with_output()`, which buffers); kill-on-drop is not a process-tree manager
- `RunAsNode` fuse: the child enters `NodeMain` without the browser stack but still loads Electron's V8/ICU — native Node restrictions apply, and memory parity with standalone Node is not guaranteed

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

- body gets `signal`, `require`, `process`, `console`, top-level `await`/`return`, no `args`; returns are ignored, and `process.exit` ends the task, not the host
- no default deadline; `.timeout(...)`, `.max_output_bytes(...)` (16 MiB), and `.on_output(...)` are per call
- globals stay shared — a trusted Rust-side API, not a sandbox — and cancellation cannot interrupt synchronous JavaScript

`electron(binary, args)` is the blocking counterpart: clears `ELECTRON_RUN_AS_NODE`, waits, returns `Output` (use `spawn_blocking` in async code). Neither connects to the RPC bridge; `ElectronBuilder::node`/`electron` wrap them for a prepared distribution.

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

See the [Rust source](src/lib.rs), [bundled bridge](assets/main.cjs), [examples](example/), and [integration tests](tests/). The Tauri adapter lives in the separate [tauri-runtime-electron](https://github.com/hairyf/tauri-runtime-electron) project.

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE-2.0).
