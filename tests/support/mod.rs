use std::{
  io::Read,
  path::Path,
  process::{Command, Stdio},
  thread,
  time::{Duration, Instant},
};

pub fn assert_node_stderr(stderr: &[u8], expected: &[u8]) {
  let prefix = stderr
    .strip_suffix(expected)
    .expect("Node stderr preserves requested bytes");
  #[cfg(windows)]
  if !prefix.is_empty() {
    let diagnostic = std::str::from_utf8(prefix).expect("Electron diagnostic is UTF-8");
    let lines: Vec<_> = diagnostic.lines().collect();
    assert!(!lines.is_empty());
    for line in lines {
      assert!(line.starts_with('['));
      assert!(line.contains(r"ERROR:third_party\crashpad\crashpad\util\win\registration_protocol_win.cc:108] CreateFile:"));
      assert!(line.ends_with("(0x2)"));
    }
  }
  #[cfg(not(windows))]
  assert!(prefix.is_empty(), "unexpected Node stderr prefix: {prefix:?}");
}

// Node executes the production JavaScript; Rust owns the assertions. These
// fixtures never launch Electron or children, and each has a parent deadline.
pub fn node(script: impl AsRef<Path>, args: &[&str]) -> String {
  let script = script.as_ref();
  let mut child = Command::new("node")
    .arg(script)
    .args(args)
    .stdout(Stdio::piped())
    .stderr(Stdio::inherit())
    .spawn()
    .unwrap_or_else(|error| panic!("run {} (Node 24+ required): {error}", script.display()));
  let mut stdout = child.stdout.take().unwrap();
  let output = thread::spawn(move || {
    let mut text = String::new();
    stdout.read_to_string(&mut text).unwrap();
    text
  });
  let deadline = Instant::now() + Duration::from_secs(15);
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
      result => {
        let _ = child.kill();
        let _ = child.wait();
        panic!("{} timed out or failed to wait: {result:?}", script.display());
      }
    }
  };
  let output = output.join().expect("read Node fixture output");
  assert!(status.success(), "{} failed with {status}: {output}", script.display());
  output
}
