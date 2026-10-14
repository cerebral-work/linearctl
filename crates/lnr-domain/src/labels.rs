//! Pure label resolution by case-insensitive name with closest-match suggestions.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::closest::closest_names;
use crate::error::CliError;

/// Minimal label representation (`{ id, name }`) used for name-to-ID resolution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedLabel {
    /// Label UUID or identifier.
    pub id: String,
    /// Human-readable label name.
    pub name: String,
}

/// Map requested label names to their IDs case-insensitively.
///
/// # Errors
///
/// Returns a [`CliError`] (`not_found`, exit code 4) listing every unmatched
/// label name and up to 3 closest available labels if any requested label is missing.
pub fn pick_label_ids<S: AsRef<str>>(
    available: &[NamedLabel],
    requested: &[S],
    team_key: Option<&str>,
) -> Result<Vec<String>, CliError> {
    if requested.is_empty() {
        return Ok(Vec::new());
    }

    let by_name: HashMap<String, &str> = available
        .iter()
        .map(|l| (l.name.to_lowercase(), l.id.as_str()))
        .collect();

    let mut ids = Vec::with_capacity(requested.len());
    let mut missing: Vec<String> = Vec::new();

    for req in requested {
        let raw = req.as_ref();
        let key = raw.trim().to_lowercase();
        if let Some(&id) = by_name.get(&key) {
            ids.push(id.to_string());
        } else {
            missing.push(raw.to_string());
        }
    }

    if !missing.is_empty() {
        let avail_names: Vec<&str> = available.iter().map(|l| l.name.as_str()).collect();
        let closest = closest_names(&missing, &avail_names);
        let missing_quoted: Vec<String> = missing
            .iter()
            .map(|m| serde_json::to_string(m).unwrap_or_else(|_| format!("\"{m}\"")))
            .collect();
        let closest_quoted: Vec<String> = closest
            .iter()
            .map(|n| serde_json::to_string(n).unwrap_or_else(|_| format!("\"{n}\"")))
            .collect();
        let closest_display = if closest_quoted.is_empty() {
            "(none available)".to_string()
        } else {
            closest_quoted.join(", ")
        };
        let team = team_key.unwrap_or("<key>");
        return Err(CliError::not_found(
            format!("unknown label(s): {}.", missing_quoted.join(", ")),
            format!("List labels: linearctl label list --team {team}; closest: {closest_display}."),
        ));
    }

    Ok(ids)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn labels_report_three_closest_names_and_discovery_command() {
        let labels: Vec<NamedLabel> = ["feature", "skill", "skills-ui", "skies", "unrelated"]
            .into_iter()
            .map(|name| NamedLabel {
                id: name.to_string(),
                name: name.to_string(),
            })
            .collect();

        assert_eq!(
            pick_label_ids(&labels, &["skill"], None).unwrap(),
            vec!["skill"]
        );

        let err = pick_label_ids(&labels, &["skills"], Some("ENG")).unwrap_err();
        assert_eq!(err.code, 4);
        assert!(err.hint.contains("linearctl label list --team ENG"));
        assert!(err.hint.contains("\"skill\", \"skies\", \"skills-ui\""));
        assert!(!err.hint.contains("unrelated"));
    }
}
