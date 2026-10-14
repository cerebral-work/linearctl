//! Domain model for `lnr`.
//!
//! This crate holds pure logic. It does no I/O: no files, no network, no
//! processes, no async runtime. Adapters live in other crates and implement
//! the [`ItemRepository`] port.
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

mod error;
mod item;
mod repository;

pub use error::DomainError;
pub use item::{Item, ItemId, ItemState};
pub use repository::ItemRepository;
