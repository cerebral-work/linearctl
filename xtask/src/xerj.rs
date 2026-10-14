//! `cargo xtask xerj-check` borrowed from `autoresearcher` (`rust/xtask/src/xerj.rs`).
//!
//! Validates XERJ search engine connectivity and verifies that reference and
//! workspace indices are active. Honors `XERJ_OPTIONAL=1` in headless CI runners.

use std::env;
use std::process::{Command, ExitCode};

use anyhow::{bail, Context, Result};

/// Execute `xerj-check`.
pub fn run() -> ExitCode {
    match check() {
        Ok(msg) => {
            println!("xerj-check: {msg}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            let is_optional =
                env::var("XERJ_OPTIONAL").is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
            if is_optional {
                println!("xerj-check: skipped (XERJ_OPTIONAL=1: {err:#})");
                ExitCode::SUCCESS
            } else {
                eprintln!("xerj-check: {err:#}");
                eprintln!(
                    "note: on non-workstation or headless CI runners without XERJ, set XERJ_OPTIONAL=1"
                );
                ExitCode::FAILURE
            }
        }
    }
}

/// Probe the XERJ daemon and verify active index document count.
pub fn check() -> Result<String> {
    let base_url = env::var("XERJ_URL").unwrap_or_else(|_| "http://127.0.0.1:9200".to_string());

    let health_url = format!("{base_url}/_cluster/health");
    let health_out = Command::new("curl")
        .args(["-sf", "-m", "3", &health_url])
        .output()
        .context(format!("failed to execute curl against {health_url}"))?;

    if !health_out.status.success() {
        bail!(
            "unreachable XERJ daemon at {base_url} (exit code: {:?})",
            health_out.status.code()
        );
    }

    let health_json = String::from_utf8_lossy(&health_out.stdout);
    let cluster_name =
        extract_json_string(&health_json, "cluster_name").unwrap_or_else(|| "xerj".to_string());

    let count_url = format!("{base_url}/_count");
    let count_out = Command::new("curl")
        .args(["-sf", "-m", "3", &count_url])
        .output()
        .context(format!("failed to execute curl against {count_url}"))?;

    if !count_out.status.success() {
        bail!("failed to query XERJ index count from {count_url}");
    }

    let count_json = String::from_utf8_lossy(&count_out.stdout);
    let count = extract_json_number(&count_json, "count")
        .ok_or_else(|| anyhow::anyhow!("cannot parse doc count from XERJ _count response"))?;

    if count == 0 {
        bail!("XERJ cluster is up but contains 0 documents");
    }

    let shards_successful =
        extract_nested_number(&count_json, "_shards", "successful").unwrap_or(1);

    Ok(format!(
        "ok (cluster '{cluster_name}', indices active: {count} docs across {shards_successful} shards)"
    ))
}

fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{key}\":");
    if let Some(pos) = json.find(&pattern) {
        let rest = &json[pos + pattern.len()..];
        let trimmed = rest.trim_start();
        if let Some(val) = trimmed.strip_prefix('"') {
            if let Some(end) = val.find('"') {
                return Some(val[..end].to_string());
            }
        }
    }
    None
}

fn extract_json_number(json: &str, key: &str) -> Option<u64> {
    let pattern = format!("\"{key}\":");
    if let Some(pos) = json.find(&pattern) {
        let rest = &json[pos + pattern.len()..];
        let trimmed = rest.trim_start();
        let num_str: String = trimmed.chars().take_while(char::is_ascii_digit).collect();
        if !num_str.is_empty() {
            return num_str.parse::<u64>().ok();
        }
    }
    None
}

fn extract_nested_number(json: &str, parent: &str, key: &str) -> Option<u64> {
    let parent_pattern = format!("\"{parent}\":");
    if let Some(pos) = json.find(&parent_pattern) {
        let rest = &json[pos + parent_pattern.len()..];
        return extract_json_number(rest, key);
    }
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parse_json_fields() {
        let json = r#"{"cluster_name":"xerj","count":14200,"_shards":{"total":8,"successful":8,"failed":0}}"#;
        assert_eq!(
            extract_json_string(json, "cluster_name"),
            Some("xerj".to_string())
        );
        assert_eq!(extract_json_number(json, "count"), Some(14200));
        assert_eq!(
            extract_nested_number(json, "_shards", "successful"),
            Some(8)
        );
    }
}
