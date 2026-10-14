//! `lnr` (`linearctl`) command line entry point.

mod cli;
mod graphql;
mod mcp;
mod memory;
mod store;

use std::process::ExitCode;

use tracing_subscriber::EnvFilter;

/// Version text: crate version plus the git revision stamped by `build.rs`.
const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), " (", env!("LNR_BUILD_REV"), ")");

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = cli::run_cli(&args, VERSION);
    ExitCode::from(code)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn demo_and_help_succeed() {
        let code = cli::run_cli(
            &["demo".to_string(), "--id".to_string(), "abc".to_string()],
            VERSION,
        );
        assert_eq!(code, 0);
        let help_code = cli::run_cli(&["--help".to_string()], VERSION);
        assert_eq!(help_code, 0);
    }

    #[test]
    fn demo_rejects_bad_id() {
        let code = cli::run_cli(
            &["demo".to_string(), "--id".to_string(), "Bad Id".to_string()],
            VERSION,
        );
        assert_eq!(code, 2);
    }
}
