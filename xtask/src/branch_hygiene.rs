//! `cargo xtask branch-hygiene [--dry-run|--apply]` borrowed from `autoresearcher`.
//!
//! Prunes local branches whose changes have landed on `origin/main`.
//! Conforms strictly to `~/.agents/sops/post-merge-branch-hygiene.md`.

use std::path::Path;
use std::process::{Command, ExitCode};

use anyhow::{bail, Context, Result};

/// Execute `branch-hygiene` against `root`.
pub fn run(root: &Path) -> ExitCode {
    let args: Vec<String> = std::env::args().skip(2).collect();
    let apply = args.iter().any(|a| a == "--apply");
    match check_and_prune(root, apply) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("branch-hygiene: {err:#}");
            ExitCode::FAILURE
        }
    }
}

fn git(root: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .with_context(|| format!("failed to run git {args:?}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        bail!("git {:?} failed: {}", args, err.trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn check_and_prune(root: &Path, apply: bool) -> Result<()> {
    println!("branch-hygiene: fetching origin with prune...");
    let _ = git(root, &["fetch", "origin", "--quiet", "--prune"]);

    let current_branch = git(root, &["branch", "--show-current"])?;
    let branches_raw = git(
        root,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    )?;

    let mut cleanable = Vec::new();
    let mut active = Vec::new();

    for line in branches_raw.lines() {
        let b = line.trim();
        if b.is_empty() || b == "main" || b == "master" || b == current_branch {
            continue;
        }

        let paths_raw = git(
            root,
            &["diff", "--name-only", &format!("origin/main...{b}")],
        )?;
        let paths: Vec<&str> = paths_raw
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();

        if paths.is_empty() {
            cleanable.push((b.to_string(), "no changes relative to origin/main"));
            continue;
        }

        let mut diff_args = vec!["diff", b, "origin/main", "--"];
        diff_args.extend(paths.iter());

        let diff_out = git(root, &diff_args)?;
        if diff_out.trim().is_empty() {
            cleanable.push((b.to_string(), "scoped diff against origin/main is empty"));
        } else {
            active.push(b.to_string());
        }
    }

    if cleanable.is_empty() {
        println!("branch-hygiene: all local branches are active (0 cleanable).");
    } else {
        println!(
            "branch-hygiene: found {} cleanable branch(es):",
            cleanable.len()
        );
        for (b, reason) in &cleanable {
            if apply {
                let _ = git(root, &["branch", "-D", b])?;
                println!("  [deleted] {b} ({reason})");
            } else {
                println!("  [cleanable] {b} ({reason})");
            }
        }
    }

    if !active.is_empty() {
        println!(
            "branch-hygiene: retained {} active branch(es) with unmerged changes:",
            active.len()
        );
        for b in &active {
            println!("  [retained] {b}");
        }
    }

    if !apply && !cleanable.is_empty() {
        println!("\nRun with `cargo xtask branch-hygiene --apply` to delete cleanable branches.");
    }

    Ok(())
}
