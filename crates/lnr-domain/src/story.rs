//! User-story description builder for `lnr park`.

use serde::{Deserialize, Serialize};

/// Inputs for building a structured user-story markdown description.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoryParts {
    /// Story title (fallback when `want` is omitted).
    pub title: String,
    /// Optional persona (`"As a <persona>,"`).
    pub persona: Option<String>,
    /// Optional goal (`"I want <want>"`).
    pub want: Option<String>,
    /// Optional payoff (`"so that <why>."`).
    pub why: Option<String>,
    /// Acceptance criteria lines.
    pub acceptance: Vec<String>,
}

/// Build a user-story markdown description from the supplied [`StoryParts`], or `None` if no story fields were set.
#[must_use]
pub fn build_story_description(parts: &StoryParts) -> Option<String> {
    let accept: Vec<&str> = parts
        .acceptance
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    if parts.persona.is_none() && parts.want.is_none() && parts.why.is_none() && accept.is_empty() {
        return None;
    }

    let mut lines: Vec<String> = Vec::new();
    if parts.persona.is_some() || parts.want.is_some() || parts.why.is_some() {
        let persona = parts.persona.as_deref().unwrap_or("user");
        let want = parts.want.as_deref().unwrap_or(&parts.title);
        let punct = if parts.why.is_some() { "," } else { "." };
        lines.push(format!("As a {persona},"));
        lines.push(format!("I want {want}{punct}"));
        if let Some(why) = &parts.why {
            lines.push(format!("so that {why}."));
        }
    }

    if !accept.is_empty() {
        if !lines.empty_check() {
            lines.push(String::new());
        }
        lines.push("## Acceptance criteria".to_string());
        for a in accept {
            lines.push(format!("- {a}"));
        }
    }

    Some(lines.join("\n"))
}

trait VecEmptyExt {
    fn empty_check(&self) -> bool;
}

impl<T> VecEmptyExt for Vec<T> {
    fn empty_check(&self) -> bool {
        self.is_empty()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn builds_story_only_when_parts_supplied() {
        let empty = StoryParts {
            title: "Add export".to_string(),
            ..Default::default()
        };
        assert_eq!(build_story_description(&empty), None);

        let full = StoryParts {
            title: "Add export".to_string(),
            persona: Some("operator".to_string()),
            want: Some("JSONL export".to_string()),
            why: Some("audit logs can be archived".to_string()),
            acceptance: vec!["streams to stdout".to_string()],
        };
        let rendered = build_story_description(&full).unwrap();
        assert!(rendered.contains("As a operator,"));
        assert!(rendered.contains("I want JSONL export,"));
        assert!(rendered.contains("so that audit logs can be archived."));
        assert!(rendered.contains("## Acceptance criteria\n- streams to stdout"));
    }
}
