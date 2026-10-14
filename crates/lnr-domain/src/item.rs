use std::fmt;

use serde::{Deserialize, Serialize};

use crate::DomainError;

/// Longest allowed item id, in bytes.
const MAX_ID_LEN: usize = 64;

/// A validated item id: 1 to 64 chars of `a-z`, `0-9` and `-`, starting with a letter.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ItemId(String);

impl ItemId {
    /// Validate `text` and wrap it.
    pub fn new(text: impl Into<String>) -> Result<Self, DomainError> {
        let id = text.into();
        let reason = if id.is_empty() {
            Some("must not be empty")
        } else if id.len() > MAX_ID_LEN {
            Some("must be at most 64 bytes")
        } else if !id.starts_with(|c: char| c.is_ascii_lowercase()) {
            Some("must start with a lowercase letter")
        } else if !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            Some("may contain only a-z, 0-9 and '-'")
        } else {
            None
        };
        match reason {
            Some(reason) => Err(DomainError::InvalidId { id, reason }),
            None => Ok(Self(id)),
        }
    }

    /// The id as text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ItemId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for ItemId {
    type Error = DomainError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<ItemId> for String {
    fn from(id: ItemId) -> Self {
        id.0
    }
}

/// Lifecycle state of an [`Item`].
///
/// Legal moves: `Draft -> Active -> Done`, and `Draft | Active -> Archived`.
/// `Done` and `Archived` are final.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemState {
    /// Created, not started.
    Draft,
    /// In progress.
    Active,
    /// Finished.
    Done,
    /// Dropped.
    Archived,
}

/// Core domain entity for workflow items.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    id: ItemId,
    state: ItemState,
}

impl Item {
    /// Create an item in the [`ItemState::Draft`] state.
    pub fn new(id: ItemId) -> Self {
        Self {
            id,
            state: ItemState::Draft,
        }
    }

    /// The item id.
    pub fn id(&self) -> &ItemId {
        &self.id
    }

    /// The current state.
    pub fn state(&self) -> ItemState {
        self.state
    }

    /// Move `Draft` to `Active`.
    pub fn activate(self) -> Result<Self, DomainError> {
        self.transition(ItemState::Active)
    }

    /// Move `Active` to `Done`.
    pub fn complete(self) -> Result<Self, DomainError> {
        self.transition(ItemState::Done)
    }

    /// Move `Draft` or `Active` to `Archived`.
    pub fn archive(self) -> Result<Self, DomainError> {
        self.transition(ItemState::Archived)
    }

    fn transition(mut self, to: ItemState) -> Result<Self, DomainError> {
        use ItemState::{Active, Archived, Done, Draft};
        let legal = matches!(
            (self.state, to),
            (Draft, Active) | (Active, Done) | (Draft | Active, Archived)
        );
        if !legal {
            return Err(DomainError::IllegalTransition {
                from: self.state,
                to,
            });
        }
        self.state = to;
        Ok(self)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn item_in(state: ItemState) -> Item {
        let mut item = Item::new(ItemId::new("x").unwrap());
        match state {
            ItemState::Draft => {}
            ItemState::Active => item = item.activate().unwrap(),
            ItemState::Done => item = item.activate().unwrap().complete().unwrap(),
            ItemState::Archived => item = item.archive().unwrap(),
        }
        item
    }

    #[test]
    fn legal_transitions_succeed() {
        assert_eq!(
            item_in(ItemState::Draft).activate().unwrap().state(),
            ItemState::Active
        );
        assert_eq!(
            item_in(ItemState::Active).complete().unwrap().state(),
            ItemState::Done
        );
        assert_eq!(
            item_in(ItemState::Draft).archive().unwrap().state(),
            ItemState::Archived
        );
        assert_eq!(
            item_in(ItemState::Active).archive().unwrap().state(),
            ItemState::Archived
        );
    }

    #[test]
    fn every_illegal_transition_errors() {
        use ItemState::{Active, Archived, Done, Draft};
        let all = [Draft, Active, Done, Archived];
        let legal = [
            (Draft, Active),
            (Active, Done),
            (Draft, Archived),
            (Active, Archived),
        ];
        for from in all {
            for (to, step) in [
                (
                    Active,
                    Item::activate as fn(Item) -> Result<Item, DomainError>,
                ),
                (Done, Item::complete),
                (Archived, Item::archive),
            ] {
                let result = step(item_in(from));
                if legal.contains(&(from, to)) {
                    assert!(result.is_ok(), "{from:?} -> {to:?} should be legal");
                } else {
                    assert_eq!(
                        result,
                        Err(DomainError::IllegalTransition { from, to }),
                        "{from:?} -> {to:?} should fail"
                    );
                }
            }
        }
    }

    #[test]
    fn valid_ids_are_accepted() {
        for ok in ["a", "item-1", "a1-b2-c3"] {
            assert_eq!(ItemId::new(ok).unwrap().as_str(), ok);
        }
        assert!(ItemId::new("a".repeat(64)).is_ok());
    }

    #[test]
    fn invalid_ids_are_rejected() {
        for bad in ["", "1abc", "-abc", "Abc", "a_b", "a b", "a.b", "\u{e9}"] {
            assert!(
                matches!(ItemId::new(bad), Err(DomainError::InvalidId { .. })),
                "{bad:?} should be rejected"
            );
        }
        assert!(ItemId::new("a".repeat(65)).is_err());
    }

    #[test]
    fn serde_validates_ids() {
        let ok: Result<ItemId, _> = serde_json::from_str("\"good-id\"");
        assert!(ok.is_ok());
        let bad: Result<ItemId, _> = serde_json::from_str("\"Bad Id\"");
        assert!(bad.is_err());
    }
}
