//! Estate `cargo xtask` contract v1 (2026-10-14): the pinned gate tools, the `ci`
//! step runner and `install`.
//!
//! Std-only, so every repo's xtask can carry the same file.
//! - `tools`: `cargo install --locked --version X` for each tool in [`TOOLS`], only
//!   when it is missing or reports another version.
//! - `ci`: runs [`CI_STEPS`] in order, stops at the first failure, prints one
//!   summary line per step and fails when any step failed.
//! - `install`: `ci`, then a `--locked` release build of every binary target.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A gate tool, installed with `cargo install --locked --version <version> <krate>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tool {
    /// Package name on crates.io.
    pub krate: &'static str,
    /// Exact pinned version.
    pub version: &'static str,
    /// Command that prints the installed version; the program comes first.
    pub probe: &'static [&'static str],
}

/// The pinned gate tools. Change a version here and nowhere else.
pub const TOOLS: &[Tool] = &[
    Tool {
        krate: "cargo-deny",
        version: "0.19.9",
        probe: &["cargo", "deny", "--version"],
    },
    Tool {
        krate: "typos-cli",
        version: "1.49.0",
        probe: &["typos", "--version"],
    },
    Tool {
        krate: "cargo-machete",
        version: "0.9.1",
        probe: &["cargo-machete", "--version"],
    },
    Tool {
        krate: "cargo-nextest",
        version: "0.9.104",
        probe: &["cargo", "nextest", "--version"],
    },
];

/// How `machete` runs cargo-machete: program and arguments. The binary is called
/// directly: under `cargo xtask`, CARGO and CARGO_PKG_NAME are both set, and then
/// cargo-machete reads `cargo machete <args>` as paths to scan.
pub const MACHETE: (&str, &[&str]) = ("cargo-machete", &[]);

/// The steps of `cargo xtask ci`, in contract order.
pub const CI_STEPS: &[&str] = &[
    "tools",
    "toolchain-check",
    "fmt-check",
    "clippy",
    "test",
    "doc-test",
    "deny",
    "typos",
    "machete",
];

/// Every subcommand the contract requires of an xtask.
#[cfg(test)]
pub const CONTRACT_COMMANDS: &[&str] = &[
    "tools",
    "toolchain-check",
    "fmt",
    "fmt-check",
    "clippy",
    "test",
    "doc-test",
    "deny",
    "typos",
    "machete",
    "ci",
    "install",
];

/// The version in a tool's `--version` output: the first `X.Y.Z` token on the
/// first line. Handles `cargo-deny 0.19.9`, `typos-cli 1.49.0`, a bare `0.9.1`
/// (cargo-machete) and `cargo-nextest 0.9.104 (<sha> <date>)`.
pub fn parse_tool_version(output: &str) -> Option<&str> {
    output
        .lines()
        .next()?
        .split_whitespace()
        .map(|token| token.strip_prefix('v').unwrap_or(token))
        .find(|token| is_version(token))
}

fn is_version(token: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// True when a tool is missing or reports a version other than its pin.
pub fn needs_install(installed: Option<&str>, pinned: &str) -> bool {
    installed != Some(pinned)
}

/// `cargo` arguments that install one tool at its pin.
pub fn install_args<'a>(tool: &'a Tool, jobs: &'a str) -> Vec<&'a str> {
    vec![
        "install",
        "--locked",
        "--version",
        tool.version,
        tool.krate,
        "-j",
        jobs,
    ]
}

/// `cargo` arguments for the release build that `install` runs after `ci`.
pub fn release_build_args(jobs: &str) -> Vec<&str> {
    vec![
        "build",
        "--release",
        "--locked",
        "--workspace",
        "--bins",
        "-j",
        jobs,
    ]
}

/// Run `program args` in `root`, echoing the command line first.
pub fn run(root: &Path, program: &str, args: &[&str]) -> bool {
    eprintln!("+ {program} {}", args.join(" "));
    Command::new(program)
        .args(args)
        .current_dir(root)
        .status()
        .is_ok_and(|status| status.success())
}

fn installed_version(root: &Path, tool: &Tool) -> Option<String> {
    let (program, args) = tool.probe.split_first()?;
    let out = Command::new(program)
        .args(args)
        .current_dir(root)
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_tool_version(&String::from_utf8_lossy(&out.stdout)).map(str::to_owned)
}

/// `cargo xtask tools`: install each pinned tool that is missing or at another
/// version, then check that the tool now reports its pin.
pub fn run_tools(root: &Path, jobs: &str) -> bool {
    for tool in TOOLS {
        let found = installed_version(root, tool);
        if !needs_install(found.as_deref(), tool.version) {
            println!("tools: {} {} ok", tool.krate, tool.version);
            continue;
        }
        println!(
            "tools: {} is {}; installing {}",
            tool.krate,
            found.as_deref().unwrap_or("missing"),
            tool.version
        );
        if !run(root, "cargo", &install_args(tool, jobs)) {
            eprintln!(
                "tools: cargo install {} {} failed",
                tool.krate, tool.version
            );
            return false;
        }
        let now = installed_version(root, tool);
        if needs_install(now.as_deref(), tool.version) {
            eprintln!(
                "tools: {} reports {} after the install; put the cargo install bin directory first on PATH",
                tool.krate,
                now.as_deref().unwrap_or("nothing"),
            );
            return false;
        }
        println!("tools: {} {} installed", tool.krate, tool.version);
    }
    true
}

/// What happened to one `ci` step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    /// The step ran and passed.
    Passed,
    /// The step ran and failed.
    Failed,
    /// The step did not run, because an earlier step failed.
    Skipped,
}

/// One line of the `ci` summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepReport {
    /// The step name, as in [`CI_STEPS`].
    pub name: String,
    /// What happened.
    pub status: StepStatus,
    /// Wall time; zero for a skipped step.
    pub elapsed: Duration,
}

/// Run `steps` in order through `run_step`, and stop at the first failure.
/// Every step gets a report; the steps after a failure are `Skipped`.
pub fn run_steps<F: FnMut(&str) -> bool>(steps: &[&str], mut run_step: F) -> Vec<StepReport> {
    let mut failed = false;
    let mut reports = Vec::with_capacity(steps.len());
    for &name in steps {
        if failed {
            reports.push(StepReport {
                name: name.to_owned(),
                status: StepStatus::Skipped,
                elapsed: Duration::ZERO,
            });
            continue;
        }
        let start = Instant::now();
        let passed = run_step(name);
        failed = !passed;
        reports.push(StepReport {
            name: name.to_owned(),
            status: if passed {
                StepStatus::Passed
            } else {
                StepStatus::Failed
            },
            elapsed: start.elapsed(),
        });
    }
    reports
}

/// The summary line for one step.
pub fn summary_line(report: &StepReport) -> String {
    let status = match report.status {
        StepStatus::Passed => "ok",
        StepStatus::Failed => "FAILED",
        StepStatus::Skipped => "skipped",
    };
    format!(
        "ci: {:<16} {:<8} {:>7.1}s",
        report.name,
        status,
        report.elapsed.as_secs_f64()
    )
}

/// `cargo xtask ci`: run the steps, print one summary line per step, and
/// return true only when every step passed.
pub fn run_ci<F: FnMut(&str) -> bool>(steps: &[&str], mut run_step: F) -> bool {
    let reports = run_steps(steps, |name| {
        println!("ci: --- {name}");
        run_step(name)
    });
    println!("ci: summary");
    for report in &reports {
        println!("{}", summary_line(report));
    }
    let passed = reports
        .iter()
        .all(|report| report.status == StepStatus::Passed);
    println!("ci: {}", if passed { "passed" } else { "FAILED" });
    passed
}

/// `cargo xtask install`: `ci`, then a `--locked` release build of every binary
/// target. Nothing is built when `ci` fails.
pub fn run_install<F: FnOnce() -> bool>(root: &Path, jobs: &str, ci: F) -> bool {
    if !ci() {
        eprintln!("install: ci failed; nothing was built");
        return false;
    }
    run(root, "cargo", &release_build_args(jobs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ci_steps_follow_the_contract_order() {
        assert_eq!(
            CI_STEPS,
            &[
                "tools",
                "toolchain-check",
                "fmt-check",
                "clippy",
                "test",
                "doc-test",
                "deny",
                "typos",
                "machete",
            ]
        );
    }

    #[test]
    fn tool_pins_match_the_contract() {
        let pins: Vec<(&str, &str)> = TOOLS.iter().map(|t| (t.krate, t.version)).collect();
        assert_eq!(
            pins,
            vec![
                ("cargo-deny", "0.19.9"),
                ("typos-cli", "1.49.0"),
                ("cargo-machete", "0.9.1"),
                ("cargo-nextest", "0.9.104"),
            ]
        );
    }

    #[test]
    fn parses_real_version_outputs() {
        assert_eq!(parse_tool_version("cargo-deny 0.19.9\n"), Some("0.19.9"));
        assert_eq!(parse_tool_version("typos-cli 1.49.0"), Some("1.49.0"));
        assert_eq!(parse_tool_version("0.9.1\n"), Some("0.9.1"));
        assert_eq!(
            parse_tool_version(
                "cargo-nextest 0.9.104 (0a1b2c3d4 2025-09-15)\nrelease: 0.9.104\nhost: aarch64-apple-darwin\n"
            ),
            Some("0.9.104")
        );
        assert_eq!(parse_tool_version("tool v1.2.3"), Some("1.2.3"));
    }

    #[test]
    fn rejects_output_without_a_version() {
        assert_eq!(parse_tool_version(""), None);
        assert_eq!(parse_tool_version("error: no such command: `deny`"), None);
        assert_eq!(parse_tool_version("cargo-deny 0.19"), None);
        assert_eq!(parse_tool_version("typos-cli 1.49.x"), None);
        assert_eq!(parse_tool_version("\nrelease: 0.9.104"), None);
    }

    #[test]
    fn machete_is_called_directly() {
        // Under `cargo xtask`, CARGO and CARGO_PKG_NAME are both set, so
        // cargo-machete treats `cargo machete <args>` as paths. Call the binary.
        let machete = TOOLS.iter().find(|t| t.krate == "cargo-machete");
        assert_eq!(
            machete.map(|t| t.probe),
            Some(&["cargo-machete", "--version"][..])
        );
        assert_eq!(MACHETE, ("cargo-machete", &[][..]));
    }

    #[test]
    fn installs_only_when_missing_or_at_another_version() {
        assert!(needs_install(None, "0.9.1"));
        assert!(needs_install(Some("0.9.2"), "0.9.1"));
        assert!(!needs_install(Some("0.9.1"), "0.9.1"));
    }

    #[test]
    fn install_is_locked_and_exact() {
        let tool = Tool {
            krate: "cargo-machete",
            version: "0.9.1",
            probe: &["cargo-machete", "--version"],
        };
        assert_eq!(
            install_args(&tool, "2"),
            vec![
                "install",
                "--locked",
                "--version",
                "0.9.1",
                "cargo-machete",
                "-j",
                "2"
            ]
        );
    }

    #[test]
    fn release_build_is_locked_and_covers_every_binary() {
        assert_eq!(
            release_build_args("2"),
            vec![
                "build",
                "--release",
                "--locked",
                "--workspace",
                "--bins",
                "-j",
                "2"
            ]
        );
    }

    #[test]
    fn ci_stops_at_the_first_failure() {
        let mut ran = Vec::new();
        let reports = run_steps(CI_STEPS, |step| {
            ran.push(step.to_owned());
            step != "clippy"
        });
        assert_eq!(ran, vec!["tools", "toolchain-check", "fmt-check", "clippy"]);
        assert_eq!(reports.len(), CI_STEPS.len());
        let statuses: Vec<StepStatus> = reports.iter().map(|r| r.status).collect();
        assert_eq!(
            statuses[..4],
            [
                StepStatus::Passed,
                StepStatus::Passed,
                StepStatus::Passed,
                StepStatus::Failed
            ]
        );
        assert!(statuses[4..].iter().all(|s| *s == StepStatus::Skipped));
    }

    #[test]
    fn ci_fails_when_any_step_fails() {
        assert!(run_ci(CI_STEPS, |_| true));
        assert!(!run_ci(CI_STEPS, |step| step != "tools"));
        assert!(!run_ci(CI_STEPS, |step| step != "machete"));
    }

    #[test]
    fn summary_has_one_line_per_step() {
        let reports = run_steps(&["tools", "clippy", "test"], |step| step != "clippy");
        let lines: Vec<String> = reports.iter().map(summary_line).collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].starts_with("ci: tools") && lines[0].contains(" ok "));
        assert!(lines[1].starts_with("ci: clippy") && lines[1].contains(" FAILED "));
        assert!(lines[2].starts_with("ci: test") && lines[2].contains(" skipped "));
    }

    #[test]
    fn install_builds_nothing_when_ci_fails() {
        // A failing ci returns before any cargo call, so no workspace is needed.
        assert!(!run_install(Path::new("/nonexistent"), "2", || false));
    }
}
