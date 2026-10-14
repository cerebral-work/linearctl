//! Workspace crate-graph DSM, CPM critical-path, and Wave-0 tearing audit (`cargo xtask graph-audit`)
//! borrowed from `autoresearcher` (`rust/xtask/src/graph_audit.rs`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::{Command, ExitCode};

use lnr_domain::saga::{ActivityKind, FlowGraph, SagaStep, WavePlan};
use lnr_domain::workstream::{
    ProcessLossEvaluation, ProcessLossModel, SteinerTaskKind, WorkstreamDsm, WorkstreamDsmAnalysis,
    ESTATE_WAVE_CONCURRENCY_CAP,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Canonical Wave-0 pure contract crate name in `lnr`.
pub const WAVE0_LEAF_CRATE: &str = "lnr-domain";

/// Forbidden runtime/I/O crate dependencies in Wave-0 `lnr-domain`.
pub const FORBIDDEN_WAVE0_DEPS: &[&str] = &[
    "tokio",
    "reqwest",
    "sqlx",
    "axum",
    "hyper",
    "tower",
    "tower-http",
];

/// Extracted Cargo workspace crate topology.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceCrateTopology {
    /// Sorted list of workspace member crate names.
    pub crates: Vec<String>,
    /// Intra-workspace directed edges `(dependent_crate, prerequisite_crate)`.
    pub workspace_edges: Vec<(String, String)>,
    /// External (non-workspace) normal/build dependencies per workspace crate.
    pub external_deps: BTreeMap<String, BTreeSet<String>>,
}

/// Complete DSM, Wave-0 tearing, CPM critical-path, and Steiner process-loss audit report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphAuditReport {
    /// Workspace member crates audited.
    pub crates: Vec<String>,
    /// Design Structure Matrix (DSM) coupling analysis.
    pub dsm_analysis: WorkstreamDsmAnalysis,
    /// Wave-0 contract leaf crate name (`lnr-domain`).
    pub wave0_leaf_crate: String,
    /// True if Wave-0 leaf crate has zero workspace prerequisites and zero forbidden I/O deps.
    pub wave0_zero_io_verified: bool,
    /// CPM schedule and $U_3$-bounded compilation wave plan.
    pub wave_plan: WavePlan,
    /// Steiner process-loss evaluations per compilation wave.
    pub wave_process_loss: Vec<ProcessLossEvaluation>,
}

/// Run the `graph-audit` xtask subcommand (`--json`, `--break-check`).
pub fn run(root: &Path, args: &[String]) -> ExitCode {
    let break_check = args.iter().any(|a| a == "--break-check");
    let emit_json = args.iter().any(|a| a == "--json");

    if break_check {
        match run_break_check(root) {
            Ok(msg) => {
                println!("graph-audit --break-check: ok ({msg})");
                return ExitCode::SUCCESS;
            }
            Err(err) => {
                eprintln!("graph-audit --break-check: FAILED ({err})");
                return ExitCode::FAILURE;
            }
        }
    }

    let topo = match load_workspace_topology(root) {
        Ok(t) => t,
        Err(err) => {
            eprintln!("graph-audit: {err}");
            return ExitCode::FAILURE;
        }
    };

    match audit_crate_topology(&topo) {
        Ok(report) => {
            if emit_json {
                match serde_json::to_string_pretty(&report) {
                    Ok(json) => println!("{json}"),
                    Err(err) => {
                        eprintln!("graph-audit: failed to serialize JSON: {err}");
                        return ExitCode::FAILURE;
                    }
                }
            } else {
                println!(
                    "graph-audit: ok ({} crates, tear_free_dag={}, wave0={}, waves={}, makespan={}s, critical_path={})",
                    report.crates.len(),
                    report.dsm_analysis.is_tear_free_dag,
                    report.wave0_leaf_crate,
                    report.wave_plan.waves.len(),
                    report.wave_plan.cpm.makespan,
                    report.wave_plan.cpm.critical_path.join(" -> ")
                );
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("graph-audit: failed ({err})");
            ExitCode::FAILURE
        }
    }
}

/// Stage runner signature compatible with `pipeline::run`.
pub fn run_check(root: &Path) -> ExitCode {
    run(root, &[])
}

/// Load the workspace crate topology via `cargo metadata --no-deps --format-version 1`.
pub fn load_workspace_topology(root: &Path) -> Result<WorkspaceCrateTopology, String> {
    let manifest_dir = if root.join("Cargo.toml").is_file() {
        root.to_path_buf()
    } else {
        return Err(format!("cannot locate Cargo.toml under {}", root.display()));
    };

    let output = Command::new("cargo")
        .args(["metadata", "--no-deps", "--format-version", "1"])
        .current_dir(&manifest_dir)
        .output()
        .map_err(|e| format!("failed to execute cargo metadata: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("cargo metadata failed: {}", stderr.trim()));
    }

    parse_cargo_metadata_json(&output.stdout)
}

/// Parse `cargo metadata --no-deps --format-version 1` JSON bytes into a [`WorkspaceCrateTopology`].
pub fn parse_cargo_metadata_json(bytes: &[u8]) -> Result<WorkspaceCrateTopology, String> {
    let root_val: Value =
        serde_json::from_slice(bytes).map_err(|e| format!("invalid cargo metadata JSON: {e}"))?;

    let packages = root_val
        .get("packages")
        .and_then(Value::as_array)
        .ok_or_else(|| "cargo metadata missing 'packages' array".to_string())?;

    let mut member_names = BTreeSet::new();
    for pkg in packages {
        if let Some(name) = pkg.get("name").and_then(Value::as_str) {
            member_names.insert(name.to_string());
        }
    }

    let crates: Vec<String> = member_names.iter().cloned().collect();
    let mut workspace_edges = Vec::new();
    let mut external_deps: BTreeMap<String, BTreeSet<String>> = crates
        .iter()
        .map(|c| (c.clone(), BTreeSet::new()))
        .collect();

    for pkg in packages {
        let Some(pkg_name) = pkg.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(deps) = pkg.get("dependencies").and_then(Value::as_array) else {
            continue;
        };
        for dep in deps {
            let kind = dep.get("kind").and_then(Value::as_str).unwrap_or("normal");
            if kind == "dev" {
                continue;
            }
            let Some(dep_name) = dep.get("name").and_then(Value::as_str) else {
                continue;
            };
            if member_names.contains(dep_name) {
                workspace_edges.push((pkg_name.to_string(), dep_name.to_string()));
            } else if let Some(ext) = external_deps.get_mut(pkg_name) {
                ext.insert(dep_name.to_string());
            }
        }
    }

    workspace_edges.sort();
    workspace_edges.dedup();

    Ok(WorkspaceCrateTopology {
        crates,
        workspace_edges,
        external_deps,
    })
}

/// Audit a [`WorkspaceCrateTopology`] using DSM coupling analysis, Wave-0 contract verification,
/// CPM critical-path scheduling, and Steiner $U_3$ process-loss evaluation.
pub fn audit_crate_topology(topo: &WorkspaceCrateTopology) -> Result<GraphAuditReport, String> {
    if topo.crates.is_empty() {
        return Err("workspace crate list cannot be empty".to_string());
    }

    let dsm = WorkstreamDsm::new(topo.crates.clone(), topo.workspace_edges.clone());
    let dsm_analysis = dsm.analyze();

    if !dsm_analysis.is_tear_free_dag {
        let cycles: Vec<String> = dsm_analysis
            .coupled_pairs_requiring_tearing
            .iter()
            .map(|(a, b)| format!("{a} <-> {b}"))
            .collect();
        return Err(format!(
            "DSM detected Coupled crate cycles requiring Wave-0 tearing: {}",
            cycles.join(", ")
        ));
    }

    if !topo.crates.iter().any(|c| c == WAVE0_LEAF_CRATE) {
        return Err(format!(
            "missing mandatory Wave-0 contract crate '{WAVE0_LEAF_CRATE}'"
        ));
    }

    if let Some(prereqs) = dsm.dependencies.get(WAVE0_LEAF_CRATE) {
        if !prereqs.is_empty() {
            let list: Vec<String> = prereqs.iter().cloned().collect();
            return Err(format!(
                "Wave-0 crate '{WAVE0_LEAF_CRATE}' must not depend on workspace crates, found: {}",
                list.join(", ")
            ));
        }
    }

    if let Some(ext_deps) = topo.external_deps.get(WAVE0_LEAF_CRATE) {
        let mut forbidden_found = Vec::new();
        for &forbidden in FORBIDDEN_WAVE0_DEPS {
            if ext_deps.contains(forbidden) {
                forbidden_found.push(forbidden);
            }
        }
        if !forbidden_found.is_empty() {
            return Err(format!(
                "Wave-0 crate '{WAVE0_LEAF_CRATE}' contains forbidden runtime/I/O dependencies: {}",
                forbidden_found.join(", ")
            ));
        }
    }

    let mut steps = Vec::with_capacity(topo.crates.len());
    for crate_name in &topo.crates {
        let deps: Vec<String> = dsm
            .dependencies
            .get(crate_name)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default();
        let duration_secs = 1 + (deps.len() as u64);
        let step = SagaStep::new(
            crate_name.clone(),
            format!("Build and verify crate {crate_name}"),
            ActivityKind::Verify,
            deps,
        )
        .with_duration_secs(duration_secs)
        .with_verify_cmd(vec![
            "cargo".to_string(),
            "test".to_string(),
            "-j".to_string(),
            "2".to_string(),
            "-p".to_string(),
            crate_name.clone(),
        ]);
        steps.push(step);
    }

    let flow = FlowGraph::new(
        "workspace-crate-build",
        Some("CPM and U3 wave compilation schedule for workspace crates".to_string()),
        steps,
    )
    .map_err(|e| format!("failed to construct workspace FlowGraph: {e}"))?;

    let wave_plan = flow
        .wave_plan(ESTATE_WAVE_CONCURRENCY_CAP)
        .map_err(|e| format!("failed to compute U3 wave plan: {e}"))?;

    let loss_model = ProcessLossModel::new(SteinerTaskKind::Additive, 0.25, 0.05);
    let mut wave_process_loss = Vec::with_capacity(wave_plan.waves.len());

    for wave in &wave_plan.waves {
        let capacities = vec![10.0; wave.steps.len()];
        let eval = loss_model.evaluate(&capacities);
        if !eval.within_u3_wave_cap {
            return Err(format!(
                "wave {} exceeds U3 concurrency cap ({} > {})",
                wave.wave_index, eval.team_size, ESTATE_WAVE_CONCURRENCY_CAP
            ));
        }
        wave_process_loss.push(eval);
    }

    Ok(GraphAuditReport {
        crates: topo.crates.clone(),
        dsm_analysis,
        wave0_leaf_crate: WAVE0_LEAF_CRATE.to_string(),
        wave0_zero_io_verified: true,
        wave_plan,
        wave_process_loss,
    })
}

/// Run falsifiable mutation self-tests (`--break-check`) proving `graph-audit` fails closed
/// when a DSM cycle, a Wave-0 I/O dependency, or a $U_3$ wave-cap violation is injected.
pub fn run_break_check(root: &Path) -> Result<String, String> {
    let baseline = load_workspace_topology(root)?;
    audit_crate_topology(&baseline)
        .map_err(|e| format!("positive control failed on clean workspace: {e}"))?;

    // Negative Control 1: Inject a cyclic dependency between lnr-domain and lnr-cli.
    let mut cyclic = baseline.clone();
    cyclic
        .workspace_edges
        .push((WAVE0_LEAF_CRATE.to_string(), "lnr-cli".to_string()));
    match audit_crate_topology(&cyclic) {
        Ok(_) => {
            return Err(
                "mutation 1 (cyclic DSM edge lnr-domain -> lnr-cli) unexpectedly passed"
                    .to_string(),
            )
        }
        Err(err) if err.contains("Coupled") => {}
        Err(other) => {
            return Err(format!(
                "mutation 1 failed with unexpected error message: {other}"
            ))
        }
    }

    // Negative Control 2: Inject forbidden 'tokio' runtime dependency into Wave-0 lnr-domain.
    let mut impure_wave0 = baseline;
    impure_wave0
        .external_deps
        .entry(WAVE0_LEAF_CRATE.to_string())
        .or_default()
        .insert("tokio".to_string());
    match audit_crate_topology(&impure_wave0) {
        Ok(_) => {
            return Err(
                "mutation 2 (forbidden tokio dep in lnr-domain) unexpectedly passed".to_string(),
            )
        }
        Err(err) if err.contains("Wave-0") && err.contains("tokio") => {}
        Err(other) => {
            return Err(format!(
                "mutation 2 failed with unexpected error message: {other}"
            ))
        }
    }

    // Negative Control 3: Verify Steiner ProcessLossModel flags waves larger than U3 (n = 5 > 3).
    let loss_model = ProcessLossModel::new(SteinerTaskKind::Additive, 0.25, 0.05);
    let oversized_eval = loss_model.evaluate(&[10.0; 5]);
    if oversized_eval.within_u3_wave_cap {
        return Err("mutation 3 (5-member wave) failed to flag U3 cap violation".to_string());
    }

    Ok("3 negative controls (DSM cycle, Wave-0 I/O dep, U3 cap) rejected as expected".to_string())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn live_workspace_graph_audit_and_break_check() {
        let root = crate::repo_root();
        let summary = run_break_check(&root).expect("graph-audit break-check must succeed");
        assert!(summary.contains("3 negative controls"));
    }
}
