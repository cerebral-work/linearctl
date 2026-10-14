//! Build-time version stamp. Captures `git describe` into `LNR_BUILD_REV`
//! so `--version` can print the commit. The value is `unknown` when the
//! build tree is not a git checkout.

use std::process::Command;

/// Run git with `args`. Return trimmed stdout, or None on any failure.
fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn main() {
    // Rebuild when the checked-out commit moves. A worktree keeps HEAD in its
    // own git dir and branch refs in the common dir, so watch both.
    if let Some(git_dir) = git(&["rev-parse", "--git-dir"]) {
        println!("cargo:rerun-if-changed={git_dir}/HEAD");
        if let Ok(head) = std::fs::read_to_string(format!("{git_dir}/HEAD")) {
            if let Some(reference) = head.trim().strip_prefix("ref: ") {
                let common = git(&["rev-parse", "--git-common-dir"]).unwrap_or(git_dir);
                println!("cargo:rerun-if-changed={common}/{reference}");
            }
        }
    }

    let rev =
        git(&["describe", "--always", "--dirty", "--abbrev=7"]).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=LNR_BUILD_REV={rev}");
}
