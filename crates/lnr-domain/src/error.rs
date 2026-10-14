use crate::item::ItemState;

/// Errors the domain can return.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DomainError {
    /// The item id text is not valid.
    #[error("invalid item id {id:?}: {reason}")]
    InvalidId {
        /// The rejected text.
        id: String,
        /// Why the text was rejected.
        reason: &'static str,
    },
    /// The requested state change is not allowed.
    #[error("illegal transition from {from:?} to {to:?}")]
    IllegalTransition {
        /// State before the change.
        from: ItemState,
        /// State the caller asked for.
        to: ItemState,
    },
    /// An item with this id already exists.
    #[error("item {0} already exists")]
    Duplicate(String),
    /// No item has this id.
    #[error("item {0} not found")]
    NotFound(String),
}
