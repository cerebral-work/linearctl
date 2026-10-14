//! `cargo xtask toolchain-check`.
//!
//! Fails unless the active `rustc` equals the `channel` in `rust-toolchain.toml`
//! and `[workspace.package] rust-version` is not above that channel.

use std::fs;
use std::path::Path;
use std::process::{Command, ExitCode};

use anyhow::{anyhow, bail, Context, Result};

pub fn run(root: &Path) -> ExitCode {
    match check(root) {
        Ok(msg) => {
            println!("toolchain-check: {msg}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("toolchain-check: {err:#}");
            ExitCode::FAILURE
        }
    }
}

fn check(root: &Path) -> Result<String> {
    let toolchain = fs::read_to_string(root.join("rust-toolchain.toml"))
        .context("cannot read rust-toolchain.toml")?;
    let manifest = fs::read_to_string(root.join("Cargo.toml")).context("cannot read Cargo.toml")?;
    let channel = toml_string(&toolchain, Some("toolchain"), "channel")
        .ok_or_else(|| anyhow!("no `channel` in rust-toolchain.toml"))?;
    let rust_version = toml_string(&manifest, Some("workspace.package"), "rust-version")
        .ok_or_else(|| anyhow!("no `rust-version` in [workspace.package]"))?;
    let out = Command::new("rustc")
        .arg("--version")
        .current_dir(root)
        .output()
        .context("cannot run `rustc --version`")?;
    if !out.status.success() {
        bail!("`rustc --version` failed");
    }
    let rustc = String::from_utf8_lossy(&out.stdout).trim().to_string();
    verify(&channel, &rustc, &rust_version)?;
    Ok(format!("ok ({rustc}; rust-version {rust_version})"))
}

/// Compare the pinned channel, the `rustc --version` line and the MSRV.
pub fn verify(channel: &str, rustc_line: &str, rust_version: &str) -> Result<()> {
    let actual = rustc_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| anyhow!("cannot parse rustc output {rustc_line:?}"))?;
    if actual != channel {
        bail!("rustc is {actual} but rust-toolchain.toml pins {channel}");
    }
    if parse_version(rust_version)? > parse_version(channel)? {
        bail!("rust-version {rust_version} is above the pinned channel {channel}");
    }
    Ok(())
}

/// Parse `1.85` or `1.94.1` into a comparable triple. A missing patch is 0.
fn parse_version(text: &str) -> Result<(u64, u64, u64)> {
    let mut parts = text.split('.').map(|p| p.parse::<u64>());
    let mut next = |required: bool| -> Result<u64> {
        match parts.next() {
            Some(Ok(n)) => Ok(n),
            Some(Err(_)) => bail!("bad version {text:?}"),
            None if required => bail!("bad version {text:?}"),
            None => Ok(0),
        }
    };
    let v = (next(true)?, next(true)?, next(false)?);
    if parts.next().is_some() {
        bail!("bad version {text:?}");
    }
    Ok(v)
}

/// Read `key = "value"` from the given `[section]` (or the whole file if None).
/// A minimal line scanner: enough for these two well-known files.
fn toml_string(text: &str, section: Option<&str>, key: &str) -> Option<String> {
    let mut current: Option<String> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = Some(name.trim().to_string());
            continue;
        }
        if section.is_some() && current.as_deref() != section {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == key {
                let v = v.split('#').next().unwrap_or("").trim();
                return v
                    .strip_prefix('"')
                    .and_then(|v| v.strip_suffix('"'))
                    .map(str::to_string);
            }
        }
    }
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn matching_version_passes() {
        assert!(verify("1.94.1", "rustc 1.94.1 (abc 2026-03-01)", "1.85").is_ok());
        assert!(verify("1.94.1", "rustc 1.94.1 (abc 2026-03-01)", "1.94.1").is_ok());
    }

    #[test]
    fn different_rustc_fails() {
        let err = verify("1.94.1", "rustc 1.95.0 (abc 2026-03-01)", "1.85").unwrap_err();
        assert!(err.to_string().contains("pins 1.94.1"));
        assert!(verify("1.94.1", "rustc 1.94.0 (abc 2026-03-01)", "1.85").is_err());
    }

    #[test]
    fn msrv_above_channel_fails() {
        assert!(verify("1.94.1", "rustc 1.94.1 (abc 2026-03-01)", "1.95").is_err());
        assert!(verify("1.94.1", "rustc 1.94.1 (abc 2026-03-01)", "1.94.2").is_err());
    }

    #[test]
    fn bad_input_fails() {
        assert!(verify("1.94.1", "", "1.85").is_err());
        assert!(verify("1.94.1", "rustc 1.94.1 (x)", "one.two").is_err());
        assert!(verify("1.94.1", "rustc 1.94.1 (x)", "1.2.3.4").is_err());
    }

    #[test]
    fn version_order() {
        assert!(parse_version("1.9").unwrap() < parse_version("1.10").unwrap());
        assert_eq!(parse_version("1.85").unwrap(), (1, 85, 0));
    }

    #[test]
    fn reads_sections() {
        let toolchain = "[toolchain]\nchannel = \"1.94.1\" # pin\ncomponents = []\n";
        assert_eq!(
            toml_string(toolchain, Some("toolchain"), "channel").as_deref(),
            Some("1.94.1")
        );
        let manifest =
            "[package]\nrust-version = \"1.0\"\n[workspace.package]\nrust-version = \"1.85\"\n";
        assert_eq!(
            toml_string(manifest, Some("workspace.package"), "rust-version").as_deref(),
            Some("1.85")
        );
        assert_eq!(toml_string(manifest, Some("nope"), "rust-version"), None);
    }

    #[test]
    fn check_reads_files_from_root() {
        let dir = std::env::temp_dir().join(format!("xtask-tc-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("rust-toolchain.toml"),
            "[toolchain]\nchannel = \"0.0.1\"\n",
        )
        .unwrap();
        fs::write(
            dir.join("Cargo.toml"),
            "[workspace.package]\nrust-version = \"1.85\"\n",
        )
        .unwrap();
        // The real rustc is never 0.0.1, so this must fail.
        assert!(check(&dir).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
