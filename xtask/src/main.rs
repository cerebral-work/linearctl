//! Repo automation borrowed from `autoresearcher`. Run with `cargo xtask <command>`.
//!
//! Commands:
//! - `branch-hygiene`: prune merged local branches (see `branch_hygiene.rs`).
//! - `spec-check`: validate `specs/` (see `spec_check.rs`).
//! - `toolchain-check`: verify the active Rust matches `rust-toolchain.toml`.
//! - `projectfile-check` (`pf-check`): validate `projectfile.yaml` against v1 schema.
//! - `versionset-check`: verify VersionSet topological dependency resolution.
//! - `graph-audit`: verify DSM crate-graph tear-freedom, Wave-0 purity, and CPM wave schedule.
//! - `xerj-check`: verify XERJ local index health and symbol reachability.
//! - `check`: run the full checkpointed verification DAG.

mod branch_hygiene;
mod graph_audit;
mod pipeline;
mod projectfile;
mod spec_check;
mod toolchain;
mod versionset;
mod xerj;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// The repo root: the parent of the `xtask` directory.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let cmd = args.next();
    let rest: Vec<String> = args.collect();
    let root = repo_root();

    match cmd.as_deref() {
        Some("branch-hygiene") => branch_hygiene::run(&root),
        Some("spec-check") => spec_check::run(&root),
        Some("toolchain-check") => toolchain::run(&root),
        Some("projectfile-check" | "pf-check") => projectfile::run(&root),
        Some("versionset-check") => versionset::run_check(&root),
        Some("versionset") => versionset::run(&rest),
        Some("graph-audit") => graph_audit::run(&root, &rest),
        Some("xerj-check") => xerj::run(),
        Some("check") => pipeline::run(&root, &rest),
        other => {
            if let Some(name) = other {
                eprintln!("xtask: unknown command {name:?}");
            }
            eprintln!("usage: cargo xtask <branch-hygiene|spec-check|toolchain-check|projectfile-check|versionset-check|versionset|graph-audit|xerj-check|check>");
            ExitCode::from(2)
        }
    }
}
