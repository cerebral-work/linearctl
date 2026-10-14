//! Checkpointed verification pipeline (`cargo xtask check`) borrowed from `autoresearcher`
//! (`rust/xtask/src/pipeline.rs`).
//!
//! Compiles the workspace verification gate DAG (`spec-check`, `toolchain-check`,
//! `projectfile-check`, `versionset-check`, `zero-io-domain`, `graph-audit`, `xerj-check`),
//! evaluates Goldratt Drum-Buffer-Rope (DBR) build queue admission (`WorkstreamQueueMetrics`),
//! and persists stage completion receipts keyed by both a 64-bit FNV-1a worktree fingerprint
//! and a SHA-256 Content-Addressed Store (CAS) receipt.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use lnr_domain::crypto::sha256_hex;
use lnr_domain::reviews::{build_cas_r2_key, fnv1a_64, verify_handoff_bytes};
use lnr_domain::saga::{ActivityKind, FlowGraph, SagaStep};
use lnr_domain::workstream::{
    DbrAdmissionDecision, WorkstreamQueueConfig, WorkstreamQueueMetrics,
    DEFAULT_DBR_MAX_UTILIZATION, ESTATE_WAVE_CONCURRENCY_CAP,
};
use serde::{Deserialize, Serialize};

use crate::{graph_audit, projectfile, spec_check, toolchain, versionset, xerj};

/// Canonical date partition used for deterministic local-to-R2 CAS key derivation.
pub const DEFAULT_CAS_DATE_PARTITION: &str = "2026-10-14";

/// Canonical artifact filename for `xtask check` CAS receipts.
pub const XTASK_CAS_RECEIPT_FILENAME: &str = "xtask-check-receipt.json";

/// Persistent checkpoint record for `cargo xtask check --resume`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineCheckpoint {
    /// Git commit SHA at the time the checkpoint was recorded.
    pub git_head: String,
    /// Deterministic 64-bit FNV-1a worktree fingerprint (`HEAD:status:diff:untracked`).
    #[serde(default)]
    pub tree_fingerprint: String,
    /// 64-character lowercase hex SHA-256 digest of `tree_fingerprint`.
    #[serde(default)]
    pub digest_hex: String,
    /// Canonical Cloudflare R2 CAS object key (`mesh-handoffs/<date>/<digest>-xtask-check-receipt.json`).
    #[serde(default)]
    pub cas_r2_key: String,
    /// Ordered set of completed verification gate stages.
    pub completed_stages: BTreeSet<String>,
}

/// Tamper-evident Content-Addressed Store (CAS) receipt envelope persisted under `target/xtask-cas/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CasCheckpointReceipt {
    /// 64-character lowercase hex SHA-256 digest of `checkpoint_json` bytes.
    pub payload_digest: String,
    /// Exact byte length of `checkpoint_json`.
    pub payload_size_bytes: u64,
    /// Canonical R2 CAS key derived via `lnr_domain::reviews::build_cas_r2_key`.
    pub cas_r2_key: String,
    /// Serialized `PipelineCheckpoint` JSON payload.
    pub checkpoint_json: String,
}

/// Compile the verification pipeline [`FlowGraph`] DAG for `xtask`.
pub fn compile_pipeline_dag() -> Result<usize, String> {
    let steps = vec![
        SagaStep::new(
            "spec-check",
            "Validate LeanSpec registry",
            ActivityKind::Verify,
            vec![],
        ),
        SagaStep::new(
            "toolchain-check",
            "Validate rust-toolchain.toml",
            ActivityKind::Verify,
            vec![],
        ),
        SagaStep::new(
            "projectfile-check",
            "Validate projectfile.yaml v1 schema",
            ActivityKind::Verify,
            vec!["spec-check".into(), "toolchain-check".into()],
        ),
        SagaStep::new(
            "versionset-check",
            "Validate VersionSet topological closure",
            ActivityKind::Verify,
            vec!["toolchain-check".into()],
        ),
        SagaStep::new(
            "zero-io-domain",
            "Verify lnr-domain has zero I/O imports",
            ActivityKind::Verify,
            vec!["toolchain-check".into()],
        ),
        SagaStep::new(
            "graph-audit",
            "Audit DSM tear-freedom and U3 waves",
            ActivityKind::Verify,
            vec!["versionset-check".into(), "zero-io-domain".into()],
        ),
        SagaStep::new(
            "xerj-check",
            "Verify XERJ index reachability",
            ActivityKind::Ground,
            vec!["projectfile-check".into(), "graph-audit".into()],
        ),
    ];

    let fg = FlowGraph::new(
        "lnr-xtask-check",
        Some("Checkpointed verification DAG for lnr".to_string()),
        steps,
    )
    .map_err(|e| format!("xtask DAG build failed: {e}"))?;

    Ok(fg.steps.len())
}

fn checkpoint_path(root: &Path) -> PathBuf {
    root.join("target").join("xtask-checkpoint.json")
}

fn cas_receipt_path(root: &Path, tree_digest: &str) -> PathBuf {
    root.join("target")
        .join("xtask-cas")
        .join(format!("{tree_digest}-{XTASK_CAS_RECEIPT_FILENAME}"))
}

/// Count active `rustc` and `cargo` processes on the host via `/proc` (zero subprocess forks).
pub fn count_active_compiler_procs() -> usize {
    let self_pid = std::process::id();
    let Ok(entries) = fs::read_dir("/proc") else {
        return 1;
    };
    let mut count = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        let Ok(pid) = name_str.parse::<u32>() else {
            continue;
        };
        if pid == self_pid {
            continue;
        }
        let comm_path = entry.path().join("comm");
        if let Ok(comm) = fs::read_to_string(comm_path) {
            let trimmed = comm.trim();
            if trimmed == "rustc" || trimmed == "cargo" {
                count += 1;
            }
        }
    }
    count
}

/// Evaluate Little's Law, Kingman's VUT equation, and Goldratt Drum-Buffer-Rope (DBR)
/// admission for the build verification queue.
pub fn evaluate_build_queue_admission(
    active_wip: usize,
    current_buffer_depth: usize,
    arrival_rate_per_hour: f64,
    service_rate_per_hour: f64,
) -> WorkstreamQueueMetrics {
    let cfg = WorkstreamQueueConfig {
        active_wip: active_wip.max(1),
        current_buffer_depth,
        max_buffer_depth: ESTATE_WAVE_CONCURRENCY_CAP * 2,
        arrival_rate_per_hour,
        service_rate_per_hour,
        arrival_cv: 0.5,
        service_cv: 0.5,
        max_safe_utilization: DEFAULT_DBR_MAX_UTILIZATION,
    };
    WorkstreamQueueMetrics::evaluate(&cfg)
}

fn current_git_head(root: &Path) -> String {
    Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(root)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "unknown".to_string())
}

/// Compute a deterministic worktree fingerprint over `HEAD`, `git status --porcelain`,
/// `git diff HEAD`, and untracked file contents.
pub fn compute_tree_fingerprint(root: &Path) -> String {
    let head = current_git_head(root);

    let status = Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=all"])
        .current_dir(root)
        .output()
        .ok()
        .map(|o| o.stdout)
        .unwrap_or_default();

    let diff = Command::new("git")
        .args(["diff", "HEAD"])
        .current_dir(root)
        .output()
        .ok()
        .map(|o| o.stdout)
        .unwrap_or_default();

    let untracked = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(root)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();

    let mut untracked_hash: u64 = 0xcbf2_9ce4_8422_2325;
    for rel in untracked.lines() {
        let p = root.join(rel.trim());
        if let Ok(bytes) = fs::read(&p) {
            untracked_hash ^= fnv1a_64(rel.as_bytes());
            untracked_hash = untracked_hash.wrapping_mul(0x0100_0000_01b3);
            untracked_hash ^= fnv1a_64(&bytes);
            untracked_hash = untracked_hash.wrapping_mul(0x0100_0000_01b3);
        }
    }

    let status_hash = fnv1a_64(&status);
    let diff_hash = fnv1a_64(&diff);
    format!("{head}:{status_hash:016x}:{diff_hash:016x}:{untracked_hash:016x}")
}

/// Construct a fresh [`PipelineCheckpoint`] with SHA-256 digest and R2 CAS key derived from `tree_fingerprint`.
pub fn new_checkpoint(git_head: &str, tree_fingerprint: &str) -> PipelineCheckpoint {
    let digest_hex = sha256_hex(tree_fingerprint.as_bytes());
    let cas_r2_key = build_cas_r2_key(
        DEFAULT_CAS_DATE_PARTITION,
        &digest_hex,
        XTASK_CAS_RECEIPT_FILENAME,
    );

    PipelineCheckpoint {
        git_head: git_head.to_string(),
        tree_fingerprint: tree_fingerprint.to_string(),
        digest_hex,
        cas_r2_key,
        completed_stages: BTreeSet::new(),
    }
}

/// Verify and deserialize a [`CasCheckpointReceipt`] from disk using `lnr_domain::reviews::verify_handoff_bytes`.
pub fn verify_cas_receipt_file(path: &Path) -> Result<PipelineCheckpoint, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("cannot read CAS receipt {}: {e}", path.display()))?;
    let receipt: CasCheckpointReceipt = serde_json::from_str(&raw)
        .map_err(|e| format!("invalid CAS receipt JSON {}: {e}", path.display()))?;

    verify_handoff_bytes(
        receipt.checkpoint_json.as_bytes(),
        &receipt.payload_digest,
        receipt.payload_size_bytes,
    )
    .map_err(|e| format!("CAS receipt integrity verification failed: {e}"))?;

    serde_json::from_str::<PipelineCheckpoint>(&receipt.checkpoint_json)
        .map_err(|e| format!("invalid embedded PipelineCheckpoint JSON: {e}"))
}

/// Write a tamper-evident [`CasCheckpointReceipt`] with `0600` permissions on Unix.
pub fn write_cas_receipt_file(path: &Path, cp: &PipelineCheckpoint) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create CAS directory {}: {e}", parent.display()))?;
    }
    let checkpoint_json = serde_json::to_string_pretty(cp)
        .map_err(|e| format!("cannot serialize PipelineCheckpoint: {e}"))?;
    let payload_digest = sha256_hex(checkpoint_json.as_bytes());
    let payload_size_bytes = checkpoint_json.len() as u64;

    let receipt = CasCheckpointReceipt {
        payload_digest,
        payload_size_bytes,
        cas_r2_key: cp.cas_r2_key.clone(),
        checkpoint_json,
    };

    let raw = serde_json::to_string_pretty(&receipt)
        .map_err(|e| format!("cannot serialize CasCheckpointReceipt: {e}"))?;
    fs::write(path, &raw)
        .map_err(|e| format!("cannot write CAS receipt {}: {e}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        fs::set_permissions(path, perms)
            .map_err(|e| format!("cannot set 0600 permissions on {}: {e}", path.display()))?;
    }

    Ok(())
}

fn load_checkpoint(path: &Path, git_head: &str, tree_fingerprint: &str) -> PipelineCheckpoint {
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(cp) = serde_json::from_str::<PipelineCheckpoint>(&raw) {
            let fp_matches = if cp.tree_fingerprint.is_empty() {
                cp.git_head == git_head
            } else {
                cp.tree_fingerprint == tree_fingerprint
            };
            if cp.git_head == git_head && fp_matches {
                let mut verified = cp;
                if verified.digest_hex.is_empty() {
                    let fresh = new_checkpoint(git_head, tree_fingerprint);
                    verified.digest_hex = fresh.digest_hex;
                    verified.cas_r2_key = fresh.cas_r2_key;
                }
                return verified;
            }
        }
    }
    new_checkpoint(git_head, tree_fingerprint)
}

fn save_checkpoint(path: &Path, cp: &PipelineCheckpoint) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(cp) {
        let _ = fs::write(path, json);
    }
}

/// Assert zero I/O in `crates/lnr-domain/src`.
pub fn run_zero_io_domain(root: &Path) -> ExitCode {
    match verify_zero_io_domain(root) {
        Ok(()) => {
            println!("zero-io-domain: ok (lnr-domain/src has zero I/O imports)");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("zero-io-domain: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Verify that `crates/lnr-domain/src` contains no forbidden I/O imports.
pub fn verify_zero_io_domain(root: &Path) -> Result<(), String> {
    let domain_src = root.join("crates/lnr-domain/src");
    let mut violations = Vec::new();
    scan_dir_for_io(&domain_src, &mut violations)?;
    if !violations.is_empty() {
        return Err(format!(
            "lnr-domain must remain free of I/O, found forbidden imports:\n  {}",
            violations.join("\n  ")
        ));
    }
    Ok(())
}

fn scan_dir_for_io(dir: &Path, violations: &mut Vec<String>) -> Result<(), String> {
    let entries =
        fs::read_dir(dir).map_err(|e| format!("cannot read directory {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir_for_io(&path, violations)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            let forbidden_list: &[&str] = &["std::net", "std::fs", "std::process", "tokio"];
            let text = fs::read_to_string(&path)
                .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            for (idx, line) in text.lines().enumerate() {
                for forbidden in forbidden_list {
                    if line.contains(forbidden) {
                        violations.push(format!("{}:{}: {}", path.display(), idx + 1, line.trim()));
                    }
                }
            }
        }
    }
    Ok(())
}

/// Run falsifiable mutation self-tests (`--break-check`) across the pipeline's
/// DSM/Wave-0 graph audit, DBR queue admission controller, and CAS receipt verifier.
pub fn run_pipeline_break_check(root: &Path) -> Result<String, String> {
    let graph_msg = graph_audit::run_break_check(root)?;

    let unstable = evaluate_build_queue_admission(4, 2, 25.0, 20.0);
    if unstable.admission != DbrAdmissionDecision::RejectUnstableQueue {
        return Err(format!(
            "DBR break-check expected RejectUnstableQueue at rho=1.25, got {:?}",
            unstable.admission
        ));
    }

    let buffer_full =
        evaluate_build_queue_admission(2, ESTATE_WAVE_CONCURRENCY_CAP * 2, 10.0, 20.0);
    if buffer_full.admission != DbrAdmissionDecision::HoldBufferFull {
        return Err(format!(
            "DBR break-check expected HoldBufferFull, got {:?}",
            buffer_full.admission
        ));
    }

    let tmp_dir = std::env::temp_dir().join(format!("xtask-cas-break-{}", std::process::id()));
    let receipt_file = tmp_dir.join("tampered-receipt.json");
    let mut cp = new_checkpoint("abc1234", "abc1234:111:222:333");
    cp.completed_stages.insert("spec-check".to_string());
    write_cas_receipt_file(&receipt_file, &cp)?;

    let verified = verify_cas_receipt_file(&receipt_file)?;
    if !verified.completed_stages.contains("spec-check") {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err("CAS positive control failed to preserve completed_stages".to_string());
    }

    let raw = fs::read_to_string(&receipt_file)
        .map_err(|e| format!("failed to read CAS receipt for tampering: {e}"))?;
    let tampered = raw.replacen("spec-check", "spec-hackd", 1);
    fs::write(&receipt_file, tampered)
        .map_err(|e| format!("failed to write tampered CAS receipt: {e}"))?;

    let tamper_res = verify_cas_receipt_file(&receipt_file);
    let _ = fs::remove_dir_all(&tmp_dir);
    if tamper_res.is_ok() {
        return Err(
            "CAS break-check failed: tampered receipt unexpectedly passed SHA-256 verification"
                .to_string(),
        );
    }

    Ok(format!(
        "{graph_msg}; DBR queue rejection and SHA-256 CAS tamper rejection verified"
    ))
}

/// Run the checkpointed verification pipeline.
pub fn run(root: &Path, args: &[String]) -> ExitCode {
    if args.iter().any(|a| a == "--break-check") {
        match run_pipeline_break_check(root) {
            Ok(summary) => {
                println!("xtask check --break-check: ok ({summary})");
                return ExitCode::SUCCESS;
            }
            Err(err) => {
                eprintln!("xtask check --break-check: FAILED ({err})");
                return ExitCode::FAILURE;
            }
        }
    }

    let resume = args.iter().any(|a| a == "--resume");
    let reset = args.iter().any(|a| a == "--reset" || a == "--fresh");
    let enforce_dbr = args.iter().any(|a| a == "--enforce-dbr");

    let active_compilers = count_active_compiler_procs();
    let dbr =
        evaluate_build_queue_admission(active_compilers.max(1), active_compilers / 2, 12.0, 20.0);
    println!(
        "xtask check: DBR admission={:?} (rho={:.2}, W={:.3}h, Wq={:.3}h, active_compilers={active_compilers})",
        dbr.admission,
        dbr.utilization_rho,
        dbr.littles_law_cycle_time_hours,
        dbr.kingman_queue_wait_hours.unwrap_or(f64::INFINITY),
    );
    if enforce_dbr && dbr.admission != DbrAdmissionDecision::Admit {
        eprintln!(
            "xtask check: DBR admission gate held execution ({:?})",
            dbr.admission
        );
        return ExitCode::FAILURE;
    }

    let cp_path = checkpoint_path(root);
    if reset && cp_path.exists() {
        let _ = fs::remove_file(&cp_path);
    }

    let task_count = match compile_pipeline_dag() {
        Ok(n) => n,
        Err(err) => {
            eprintln!("xtask check: {err}");
            return ExitCode::FAILURE;
        }
    };

    let head = current_git_head(root);
    let fingerprint = compute_tree_fingerprint(root);
    let tree_digest = sha256_hex(fingerprint.as_bytes());
    let cas_path = cas_receipt_path(root, &tree_digest);
    if reset && cas_path.exists() {
        let _ = fs::remove_file(&cas_path);
    }

    let mut cp = if resume {
        if let Ok(cas_cp) = verify_cas_receipt_file(&cas_path) {
            if cas_cp.git_head == head && cas_cp.tree_fingerprint == fingerprint {
                cas_cp
            } else {
                load_checkpoint(&cp_path, &head, &fingerprint)
            }
        } else {
            load_checkpoint(&cp_path, &head, &fingerprint)
        }
    } else {
        new_checkpoint(&head, &fingerprint)
    };

    println!(
        "xtask check: compiled verification DAG ({task_count} stages, head {head}, fp {}, sha256 {}.., resume={resume})",
        &fingerprint[..fingerprint.len().min(24)],
        &cp.digest_hex[..cp.digest_hex.len().min(12)]
    );

    let stages: &[(&str, fn(&Path) -> ExitCode)] = &[
        ("spec-check", spec_check::run),
        ("toolchain-check", toolchain::run),
        ("projectfile-check", projectfile::run),
        ("versionset-check", versionset::run_check),
        ("zero-io-domain", run_zero_io_domain),
        ("graph-audit", graph_audit::run_check),
        ("xerj-check", |_r| xerj::run()),
    ];

    for (name, runner) in stages {
        if resume && cp.completed_stages.contains(*name) {
            println!("xtask check: [{name}] skipped (cached in CAS checkpoint)");
            continue;
        }
        let code = runner(root);
        if code != ExitCode::SUCCESS {
            save_checkpoint(&cp_path, &cp);
            let _ = write_cas_receipt_file(&cas_path, &cp);
            eprintln!("xtask check: failed at stage '{name}' (run with --resume after fixing)");
            return code;
        }
        cp.completed_stages.insert((*name).to_string());
        save_checkpoint(&cp_path, &cp);
        let _ = write_cas_receipt_file(&cas_path, &cp);
    }

    println!(
        "xtask check: all {task_count} verification stages passed (CAS key: {})",
        cp.cas_r2_key
    );
    ExitCode::SUCCESS
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn compile_dag_and_verify_zero_io_and_break_check() {
        assert_eq!(compile_pipeline_dag().unwrap(), 7);
        let root = crate::repo_root();
        verify_zero_io_domain(&root).unwrap();
        let msg = run_pipeline_break_check(&root).unwrap();
        assert!(msg.contains("CAS tamper rejection verified"));
    }
}
