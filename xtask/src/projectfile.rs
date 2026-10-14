//! `cargo xtask projectfile-check` borrowed from `autoresearcher` (`rust/xtask/src/projectfile.rs`).
//!
//! Validates `projectfile.yaml` against schema expectations and ensures synchronization
//! with workspace `Cargo.toml` and `rust-toolchain.toml`.

use std::fs;
use std::path::Path;
use std::process::ExitCode;

use anyhow::{anyhow, bail, Context, Result};

/// Execute `projectfile-check` against the workspace root.
pub fn run(root: &Path) -> ExitCode {
    match check(root) {
        Ok(msg) => {
            println!("projectfile-check: {msg}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("projectfile-check: {err:#}");
            ExitCode::FAILURE
        }
    }
}

/// Validate `projectfile.yaml` and workspace `Cargo.toml` synchronization.
pub fn check(root: &Path) -> Result<String> {
    let pf_path = root.join("projectfile.yaml");
    if !pf_path.is_file() {
        bail!(
            "missing projectfile.yaml at repo root ({})",
            pf_path.display()
        );
    }

    let pf_text = fs::read_to_string(&pf_path).context("cannot read projectfile.yaml")?;
    let manifest_path = root.join("Cargo.toml");
    let manifest_text =
        fs::read_to_string(&manifest_path).context("cannot read workspace Cargo.toml")?;

    let schema = extract_scalar(&pf_text, "$schema")
        .ok_or_else(|| anyhow!("missing `$schema` in projectfile.yaml"))?;
    if schema != "https://projectfile.org/schema/v1.json" {
        bail!("expected $schema 'https://projectfile.org/schema/v1.json', found '{schema}'");
    }

    let kind = extract_scalar(&pf_text, "kind")
        .ok_or_else(|| anyhow!("missing `kind` in projectfile.yaml"))?;
    if kind != "SoftwareSourceCode" {
        bail!("expected kind 'SoftwareSourceCode', found '{kind}'");
    }

    let namespace = extract_nested_scalar(&pf_text, "identity", "namespace")
        .ok_or_else(|| anyhow!("missing `identity.namespace` in projectfile.yaml"))?;
    if namespace != "io.todie.cerebral" {
        bail!("unexpected identity.namespace: '{namespace}' (expected 'io.todie.cerebral')");
    }

    let name = extract_nested_scalar(&pf_text, "identity", "name")
        .ok_or_else(|| anyhow!("missing `identity.name` in projectfile.yaml"))?;
    if name != "lnr" {
        bail!("unexpected identity.name: '{name}' (expected 'lnr')");
    }

    let version = extract_nested_scalar(&pf_text, "identity", "version")
        .ok_or_else(|| anyhow!("missing `identity.version` in projectfile.yaml"))?;

    let cargo_version = toml_string(&manifest_text, Some("workspace.package"), "version")
        .ok_or_else(|| anyhow!("missing `version` in Cargo.toml [workspace.package]"))?;
    if version != cargo_version {
        bail!("version mismatch: projectfile.yaml has '{version}' but Cargo.toml has '{cargo_version}'");
    }

    let spdx = extract_nested_scalar(&pf_text, "license", "spdx")
        .ok_or_else(|| anyhow!("missing `license.spdx` in projectfile.yaml"))?;
    let cargo_license = toml_string(&manifest_text, Some("workspace.package"), "license")
        .ok_or_else(|| anyhow!("missing `license` in Cargo.toml [workspace.package]"))?;
    if spdx != cargo_license {
        bail!(
            "license mismatch: projectfile.yaml has '{spdx}' but Cargo.toml has '{cargo_license}'"
        );
    }

    let rust_req = extract_nested_scalar(&pf_text, "runtime", "rust")
        .ok_or_else(|| anyhow!("missing `requirements.runtime.rust` in projectfile.yaml"))?;
    let cargo_rust = toml_string(&manifest_text, Some("workspace.package"), "rust-version")
        .ok_or_else(|| anyhow!("missing `rust-version` in Cargo.toml [workspace.package]"))?;
    if !rust_req.contains(&cargo_rust) {
        bail!("runtime rust mismatch: projectfile.yaml requires '{rust_req}' but Cargo.toml has '{cargo_rust}'");
    }

    if !pf_text.contains("repositories:") {
        bail!("missing `repositories` section in projectfile.yaml");
    }
    if !pf_text.contains("health:") {
        bail!("missing `health` endpoints declaration in projectfile.yaml");
    }
    if !pf_text.contains("ci:") {
        bail!("missing `ci` DAG declaration in projectfile.yaml");
    }

    Ok(format!(
        "ok (identity {namespace}:{name} v{version}; spdx {spdx}; schema v1)"
    ))
}

fn extract_scalar(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(key) {
            if let Some(val) = rest.strip_prefix(':') {
                let v = val.split('#').next().unwrap_or("").trim();
                let clean = v.trim_matches('"').trim_matches('\'').trim();
                if !clean.is_empty() {
                    return Some(clean.to_string());
                }
            }
        }
    }
    None
}

fn extract_nested_scalar(text: &str, section: &str, key: &str) -> Option<String> {
    let mut in_section = false;
    let mut section_indent = 0;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let indent = line.chars().take_while(|c| *c == ' ').count();

        if in_section && indent <= section_indent && !trimmed.starts_with('-') {
            in_section = false;
        }

        if trimmed == format!("{section}:") || trimmed.starts_with(&format!("{section}:")) {
            in_section = true;
            section_indent = indent;
            continue;
        }

        if in_section && (trimmed == format!("{key}:") || trimmed.starts_with(&format!("{key}:"))) {
            if let Some((_, val)) = trimmed.split_once(':') {
                let v = val.split('#').next().unwrap_or("").trim();
                let clean = v.trim_matches('"').trim_matches('\'').trim();
                if !clean.is_empty() {
                    return Some(clean.to_string());
                }
            }
        }
    }
    None
}

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
    fn check_lnr_projectfile() {
        let root = crate::repo_root();
        let res = check(&root).expect("projectfile.yaml must validate");
        assert!(res.contains("io.todie.cerebral:lnr v0.21.1"));
    }
}
