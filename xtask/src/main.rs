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
//!
//! Estate xtask contract v1 (see `gate.rs`):
//! - `tools`: install the pinned gate tools (cargo-deny, typos-cli, cargo-machete, cargo-nextest).
//! - `fmt` / `fmt-check`, `clippy`, `test`, `doc-test`, `deny`, `typos`, `machete`: the gates.
//! - `bun`: the TypeScript CLI, as ci.yml's `check` job builds it (install, typecheck, test, build).
//! - `ci`: `tools`, `toolchain-check`, `fmt-check`, `clippy`, `test`, `doc-test`, `deny`,
//!   `typos`, `machete`, then `bun`; stops at the first failure.
//! - `install`: `ci`, then a `--locked` release build of every binary target.

mod branch_hygiene;
mod gate;
mod graph_audit;
mod pipeline;
mod projectfile;
mod spec_check;
mod toolchain;
mod versionset;
mod xerj;

use std::env;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// The repo root: the parent of the `xtask` directory.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

/// Cargo build jobs: `JOBS`, then `CARGO_BUILD_JOBS`, else 2 (AGENTS.md rule 2).
fn jobs() -> String {
    env::var("JOBS")
        .or_else(|_| env::var("CARGO_BUILD_JOBS"))
        .unwrap_or_else(|_| "2".to_owned())
}

/// Every `cargo xtask` subcommand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cmd {
    BranchHygiene,
    SpecCheck,
    ToolchainCheck,
    ProjectfileCheck,
    VersionsetCheck,
    Versionset,
    GraphAudit,
    XerjCheck,
    Check,
    Tools,
    Fmt,
    FmtCheck,
    Clippy,
    Test,
    DocTest,
    Deny,
    Typos,
    Machete,
    Bun,
    Ci,
    Install,
}

const USAGE: &str = "usage: cargo xtask <branch-hygiene|spec-check|toolchain-check|projectfile-check|versionset-check|versionset|graph-audit|xerj-check|check|tools|fmt|fmt-check|clippy|test|doc-test|deny|typos|machete|bun|ci|install>";

/// The `ci` steps: the contract's Rust steps, then the TypeScript CLI.
fn ci_steps() -> Vec<&'static str> {
    gate::CI_STEPS.iter().copied().chain(["bun"]).collect()
}

fn parse_command(name: &str) -> Option<Cmd> {
    Some(match name {
        "branch-hygiene" => Cmd::BranchHygiene,
        "spec-check" => Cmd::SpecCheck,
        "toolchain-check" => Cmd::ToolchainCheck,
        "projectfile-check" | "pf-check" => Cmd::ProjectfileCheck,
        "versionset-check" => Cmd::VersionsetCheck,
        "versionset" => Cmd::Versionset,
        "graph-audit" => Cmd::GraphAudit,
        "xerj-check" => Cmd::XerjCheck,
        "check" => Cmd::Check,
        "tools" => Cmd::Tools,
        "fmt" => Cmd::Fmt,
        "fmt-check" => Cmd::FmtCheck,
        "clippy" => Cmd::Clippy,
        "test" => Cmd::Test,
        "doc-test" => Cmd::DocTest,
        "deny" => Cmd::Deny,
        "typos" => Cmd::Typos,
        "machete" => Cmd::Machete,
        "bun" => Cmd::Bun,
        "ci" => Cmd::Ci,
        "install" => Cmd::Install,
        _ => return None,
    })
}

fn exit_code(ok: bool) -> ExitCode {
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn cargo(root: &Path, args: &[&str]) -> ExitCode {
    exit_code(gate::run(root, "cargo", args))
}

fn run_command(root: &Path, cmd: Cmd, rest: &[String]) -> ExitCode {
    let j = jobs();
    match cmd {
        Cmd::BranchHygiene => branch_hygiene::run(root),
        Cmd::SpecCheck => spec_check::run(root),
        Cmd::ToolchainCheck => toolchain::run(root),
        Cmd::ProjectfileCheck => projectfile::run(root),
        Cmd::VersionsetCheck => versionset::run_check(root),
        Cmd::Versionset => versionset::run(rest),
        Cmd::GraphAudit => graph_audit::run(root, rest),
        Cmd::XerjCheck => xerj::run(),
        Cmd::Check => pipeline::run(root, rest),
        Cmd::Tools => exit_code(gate::run_tools(root, &j)),
        Cmd::Fmt => cargo(root, &["fmt", "--all"]),
        Cmd::FmtCheck => cargo(root, &["fmt", "--all", "--", "--check"]),
        Cmd::Clippy => cargo(
            root,
            &[
                "clippy",
                "--workspace",
                "--all-targets",
                "--locked",
                "-j",
                &j,
                "--",
                "-D",
                "warnings",
            ],
        ),
        Cmd::Test => run_test(root, &j),
        Cmd::DocTest => cargo(
            root,
            &["test", "--doc", "--workspace", "--locked", "-j", &j],
        ),
        Cmd::Deny => cargo(root, &["deny", "check"]),
        Cmd::Typos => exit_code(gate::run(root, "typos", &[])),
        Cmd::Machete => {
            let (program, args) = gate::MACHETE;
            exit_code(gate::run(root, program, args))
        }
        Cmd::Bun => run_bun(root),
        Cmd::Ci => run_ci(root),
        Cmd::Install => exit_code(gate::run_install(root, &j, || {
            run_ci(root) == ExitCode::SUCCESS
        })),
    }
}

/// nextest when installed (it reads `NEXTEST_PROFILE`), else `cargo test`.
fn run_test(root: &Path, j: &str) -> ExitCode {
    let nextest = std::process::Command::new("cargo")
        .args(["nextest", "--version"])
        .current_dir(root)
        .output()
        .is_ok_and(|out| out.status.success());
    if nextest {
        cargo(
            root,
            &[
                "nextest",
                "run",
                "--workspace",
                "--locked",
                "--build-jobs",
                j,
            ],
        )
    } else {
        cargo(root, &["test", "--workspace", "--locked", "-j", j])
    }
}

/// The TypeScript CLI, with the commands ci.yml's `check` job runs.
fn run_bun(root: &Path) -> ExitCode {
    let steps: [&[&str]; 4] = [
        &["install", "--frozen-lockfile"],
        &["run", "typecheck"],
        &["test"],
        &["run", "build"],
    ];
    exit_code(steps.iter().all(|args| gate::run(root, "bun", args)))
}

fn run_ci(root: &Path) -> ExitCode {
    exit_code(gate::run_ci(&ci_steps(), |step| {
        parse_command(step).is_some_and(|cmd| run_command(root, cmd, &[]) == ExitCode::SUCCESS)
    }))
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let root = repo_root();
    let Some((name, rest)) = args.split_first() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    match parse_command(name) {
        Some(cmd) => run_command(&root, cmd, rest),
        None => {
            eprintln!("xtask: unknown command {name:?}");
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_contract_command() {
        for name in gate::CONTRACT_COMMANDS {
            assert!(parse_command(name).is_some(), "{name} is not a command");
            assert!(
                USAGE.contains(name),
                "{name} is missing from the usage line"
            );
        }
    }

    #[test]
    fn keeps_every_existing_command() {
        let existing = [
            "branch-hygiene",
            "spec-check",
            "toolchain-check",
            "projectfile-check",
            "pf-check",
            "versionset-check",
            "versionset",
            "graph-audit",
            "xerj-check",
            "check",
        ];
        for name in existing {
            assert!(parse_command(name).is_some(), "{name} was dropped");
        }
    }

    #[test]
    fn maps_names_to_commands() {
        assert_eq!(parse_command("ci"), Some(Cmd::Ci));
        assert_eq!(parse_command("install"), Some(Cmd::Install));
        assert_eq!(parse_command("tools"), Some(Cmd::Tools));
        assert_eq!(parse_command("bun"), Some(Cmd::Bun));
        assert_eq!(parse_command("pf-check"), Some(Cmd::ProjectfileCheck));
    }

    #[test]
    fn rejects_unknown_commands() {
        assert_eq!(parse_command(""), None);
        assert_eq!(parse_command("CI"), None);
        assert_eq!(parse_command("--help"), None);
    }

    #[test]
    fn ci_runs_the_contract_steps_then_bun() {
        let steps = ci_steps();
        let (rust, rest) = steps.split_at(gate::CI_STEPS.len());
        assert_eq!(rust, gate::CI_STEPS);
        assert_eq!(rest, ["bun"]);
        for step in &steps {
            assert!(
                parse_command(step).is_some(),
                "ci step {step} has no command"
            );
            assert_ne!(parse_command(step), Some(Cmd::Ci), "ci must not run itself");
        }
    }
}
