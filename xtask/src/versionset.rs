//! VersionSet CLI subcommand (`cargo xtask versionset`) borrowed from `autoresearcher`
//! (`rust/xtask/src/versionset.rs`).

use std::fs;
use std::path::Path;
use std::process::ExitCode;

use lnr_domain::versionset::{
    ConflictPolicy, PackagePin, PackageSource, VersionSet, VersionSetResolver,
};

/// Run the `versionset` xtask command.
pub fn run(args: &[String]) -> ExitCode {
    let subcmd = args.first().map(String::as_str);

    match subcmd {
        Some("check") => run_check(Path::new(".")),
        Some("demo") => run_demo(),
        Some("resolve") => {
            let Some(manifest_path) = args.get(1) else {
                eprintln!("error: missing path to VersionSet JSON manifest");
                eprintln!("usage: cargo xtask versionset resolve <manifest.json>");
                return ExitCode::from(2);
            };
            run_resolve(Path::new(manifest_path))
        }
        _ => {
            eprintln!("usage: cargo xtask versionset <check|demo|resolve <manifest.json>>");
            ExitCode::from(2)
        }
    }
}

/// Verify deterministic VersionSet topological dependency resolution.
pub fn run_check(_root: &Path) -> ExitCode {
    let pkg_domain = PackagePin::new(
        "lnr-domain",
        "0.21.1",
        PackageSource::Path {
            path: "crates/lnr-domain".into(),
        },
        vec![],
    );
    let pkg_cli = PackagePin::new(
        "lnr-cli",
        "0.21.1",
        PackageSource::Path {
            path: "crates/lnr-cli".into(),
        },
        vec!["lnr-domain".into()],
    );
    let pkg_xtask = PackagePin::new(
        "xtask",
        "0.21.1",
        PackageSource::Path {
            path: "xtask".into(),
        },
        vec!["lnr-domain".into()],
    );
    let pkg_service = PackagePin::new(
        "lnr",
        "0.21.1",
        PackageSource::Path { path: ".".into() },
        vec!["lnr-cli".into(), "xtask".into()],
    );

    let vs = VersionSet::new(
        "lnr-version-set",
        Some("live".into()),
        vec![pkg_service, pkg_cli, pkg_xtask, pkg_domain],
    );

    let resolver = VersionSetResolver::new(ConflictPolicy::Fail);
    match resolver.resolve(&vs) {
        Ok(res) => {
            println!(
                "versionset-check: ok ({}, {} packages in build order: {})",
                res.name,
                res.build_order.len(),
                res.build_order.join(" -> ")
            );
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("versionset-check: failed ({err})");
            ExitCode::FAILURE
        }
    }
}

fn run_demo() -> ExitCode {
    println!("=== VersionSet Dependency Closure Demo (Amazon Brazil Model) ===");
    run_check(Path::new("."))
}

fn run_resolve(path: &Path) -> ExitCode {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("failed to read manifest at {}: {err}", path.display());
            return ExitCode::FAILURE;
        }
    };

    let vs: VersionSet = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(err) => {
            eprintln!("failed to parse VersionSet JSON: {err}");
            return ExitCode::FAILURE;
        }
    };

    let resolver = VersionSetResolver::new(ConflictPolicy::Fail);
    match resolver.resolve(&vs) {
        Ok(res) => {
            println!("Resolved VersionSet: {}", res.name);
            println!("Topological Build Order: {:?}", res.build_order);
            println!("\n{}", res.patch_toml);
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("Resolution error: {err}");
            ExitCode::FAILURE
        }
    }
}
