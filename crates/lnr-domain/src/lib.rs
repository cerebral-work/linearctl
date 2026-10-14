//! Domain model for `lnr` (`linearctl`).
//!
//! This crate holds pure domain logic and data structures. It performs zero
//! I/O: no filesystem access, no network sockets, no child processes, and no
//! async runtime.
//!
//! # Example
//!
//! ```
//! use lnr_domain::{DomainError, Item, ItemId, ItemState};
//!
//! fn main() -> Result<(), DomainError> {
//!     let id = ItemId::new("cer-101")?;
//!     let item = Item::new(id);
//!     assert_eq!(item.state(), ItemState::Draft);
//!     let item = item.activate()?;
//!     assert_eq!(item.state(), ItemState::Active);
//!     Ok(())
//! }
//! ```

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod beads;
pub mod bm25;
pub mod claims;
pub mod closest;
pub mod crypto;
pub mod enterprise;
pub mod error;
pub mod examples;
pub mod governance;
pub mod handoff;
mod item;
pub mod labels;
pub mod links;
pub mod loops;
pub mod math;
pub mod models;
pub mod org_psych;
pub mod plan;
pub mod priority;
mod repository;
pub mod reviews;
pub mod saga;
pub mod security;
pub mod similarity;
pub mod story;
pub mod template;
pub mod time;
pub mod token_budget;
pub mod vector_rerank;
pub mod versionset;
pub mod workstream;

pub use error::{
    assert_batch_succeeded, classify_api_error, error_envelope, format_cli_error, ApiErrorInput,
    BatchFailure, CliError, DomainError, ErrorEnvelope, ErrorEnvelopeBody, ErrorKind,
};
pub use item::{Item, ItemId, ItemState};
pub use repository::ItemRepository;
