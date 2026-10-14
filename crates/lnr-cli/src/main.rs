//! `lnr` command line entry point.

mod memory;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use lnr_domain::{Item, ItemId, ItemRepository};
use serde::Serialize;
use tracing_subscriber::EnvFilter;

use memory::InMemoryRepository;

/// Version text: crate version plus the git revision stamped by `build.rs`.
const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), " (", env!("LNR_BUILD_REV"), ")");

/// Linear workflow CLI (`lnr`).
#[derive(Debug, Parser)]
#[command(name = "lnr", version = VERSION, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Create an item, run it through its lifecycle, and print the result as JSON.
    Demo {
        /// Id for the new item.
        #[arg(long, default_value = "first-item")]
        id: String,
    },
}

/// One step of the demo lifecycle, as printed.
#[derive(Debug, Serialize)]
struct Step {
    action: &'static str,
    item: Item,
}

fn demo(id: &str) -> Result<Vec<Step>> {
    let mut repo = InMemoryRepository::default();
    let id = ItemId::new(id).context("invalid --id")?;
    let mut steps = Vec::new();

    let item = Item::new(id.clone());
    repo.insert(item.clone())?;
    steps.push(Step {
        action: "create",
        item,
    });

    let item = repo.get(&id)?.activate()?;
    repo.update(item.clone())?;
    steps.push(Step {
        action: "activate",
        item,
    });

    let item = repo.get(&id)?.complete()?;
    repo.update(item.clone())?;
    steps.push(Step {
        action: "complete",
        item,
    });

    tracing::debug!(count = repo.list().len(), "demo finished");
    Ok(steps)
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    match cli.command {
        Command::Demo { id } => {
            let steps = demo(&id)?;
            println!("{}", serde_json::to_string_pretty(&steps)?);
        }
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn demo_reaches_done() {
        let steps = demo("abc").unwrap();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[2].item.state(), lnr_domain::ItemState::Done);
    }

    #[test]
    fn demo_rejects_bad_id() {
        assert!(demo("Bad Id").is_err());
    }
}
