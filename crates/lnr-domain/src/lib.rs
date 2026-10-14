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
pub mod closest;
pub mod crypto;
pub mod error;
pub mod examples;
pub mod handoff;
mod item;
pub mod labels;
pub mod loops;
pub mod models;
pub mod plan;
pub mod priority;
mod repository;
pub mod similarity;
pub mod story;
pub mod template;
pub mod time;

pub use error::{
    assert_batch_succeeded, classify_api_error, error_envelope, format_cli_error, ApiErrorInput,
    BatchFailure, CliError, DomainError, ErrorEnvelope, ErrorEnvelopeBody, ErrorKind,
};
pub use item::{Item, ItemId, ItemState};
pub use repository::ItemRepository;
