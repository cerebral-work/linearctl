//! In-memory adapter for the [`ItemRepository`] port.

use std::collections::BTreeMap;

use lnr_domain::{DomainError, Item, ItemId, ItemRepository};

/// Keeps items in a sorted map. Data is lost when the process exits.
#[derive(Debug, Default)]
pub struct InMemoryRepository {
    items: BTreeMap<ItemId, Item>,
}

impl ItemRepository for InMemoryRepository {
    fn insert(&mut self, item: Item) -> Result<(), DomainError> {
        if self.items.contains_key(item.id()) {
            return Err(DomainError::Duplicate(item.id().to_string()));
        }
        self.items.insert(item.id().clone(), item);
        Ok(())
    }

    fn update(&mut self, item: Item) -> Result<(), DomainError> {
        match self.items.get_mut(item.id()) {
            Some(slot) => {
                *slot = item;
                Ok(())
            }
            None => Err(DomainError::NotFound(item.id().to_string())),
        }
    }

    fn get(&self, id: &ItemId) -> Result<Item, DomainError> {
        self.items
            .get(id)
            .cloned()
            .ok_or_else(|| DomainError::NotFound(id.to_string()))
    }

    fn list(&self) -> Vec<Item> {
        self.items.values().cloned().collect()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn item(id: &str) -> Item {
        Item::new(ItemId::new(id).unwrap())
    }

    #[test]
    fn insert_get_update_list() {
        let mut repo = InMemoryRepository::default();
        repo.insert(item("b")).unwrap();
        repo.insert(item("a")).unwrap();
        let id = ItemId::new("a").unwrap();
        repo.update(repo.get(&id).unwrap().activate().unwrap())
            .unwrap();
        let ids: Vec<_> = repo.list().iter().map(|i| i.id().to_string()).collect();
        assert_eq!(ids, ["a", "b"]);
    }

    #[test]
    fn duplicate_and_missing_error() {
        let mut repo = InMemoryRepository::default();
        repo.insert(item("a")).unwrap();
        assert_eq!(
            repo.insert(item("a")),
            Err(DomainError::Duplicate("a".into()))
        );
        assert_eq!(
            repo.update(item("z")),
            Err(DomainError::NotFound("z".into()))
        );
        assert_eq!(
            repo.get(&ItemId::new("z").unwrap()),
            Err(DomainError::NotFound("z".into()))
        );
    }
}
