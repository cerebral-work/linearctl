//! Pure session handoff models, frontmatter parser/serializer, and body skeleton.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::CliError;

/// Ordered section headings a complete handoff markdown body should carry.
pub const HANDOFF_SECTIONS: &[&str] = &[
    "## What landed",
    "## Verification",
    "## Decisions",
    "## Next steps",
];

/// Lifecycle status of a persisted session handoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HandoffStatus {
    /// Open/active handoff.
    Active,
    /// Resolved/closed handoff.
    Resolved,
}

impl HandoffStatus {
    /// Return the lowercase string representation (`"active"` or `"resolved"`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Resolved => "resolved",
        }
    }
}

/// A persisted session handoff document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Handoff {
    /// Derived date-prefixed slug identifier (`<YYYY-MM-DD>-<slug>`).
    pub id: String,
    /// Creation date (`YYYY-MM-DD`).
    pub date: String,
    /// Optional pull request reference (e.g. `"#112"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr: Option<String>,
    /// Optional Linear ticket reference (e.g. `"CER-1148"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket: Option<String>,
    /// Human-readable handoff title.
    pub title: String,
    /// Lifecycle status (`active` or `resolved`).
    pub status: HandoffStatus,
    /// Markdown body (without trailing newlines).
    pub body: String,
}

/// Input parameters for creating a new handoff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewHandoff {
    /// Handoff title (slugified into `id`).
    pub title: String,
    /// Optional PR reference.
    pub pr: Option<String>,
    /// Optional Linear ticket reference.
    pub ticket: Option<String>,
    /// Markdown body.
    pub body: String,
}

/// Derive a filesystem-safe handoff id (`<YYYY-MM-DD>-<slug>`) from a title and date.
#[must_use]
pub fn handoff_id(title: &str, date: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in title.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    let final_slug = if slug.is_empty() { "handoff" } else { slug };
    format!("{date}-{final_slug}")
}

fn yaml_scalar(v: &str) -> String {
    if v.is_empty() {
        return "\"\"".to_string();
    }
    let first = v.chars().next().unwrap_or(' ');
    let starts_with_indicator = matches!(
        first,
        '"' | '\'' | '#' | '!' | '&' | '*' | '?' | '>' | '|' | '@' | '`' | '%' | '-'
    );
    let is_keyword = matches!(
        v.to_ascii_lowercase().as_str(),
        "true" | "false" | "null" | "~"
    );
    let has_colon_or_comment = v.contains(": ") || v.contains(":\t") || v.contains(" #");
    let has_edge_ws = v != v.trim();

    if !(starts_with_indicator || is_keyword || has_colon_or_comment || has_edge_ws) {
        return v.to_string();
    }
    let escaped = v.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// Serialize a [`Handoff`] to its markdown storage format (YAML frontmatter + body).
#[must_use]
pub fn serialize_handoff(h: &Handoff) -> String {
    let mut lines = Vec::with_capacity(9);
    lines.push("---".to_string());
    lines.push(format!("id: {}", yaml_scalar(&h.id)));
    lines.push(format!("date: {}", yaml_scalar(&h.date)));
    lines.push(format!("title: {}", yaml_scalar(&h.title)));
    if let Some(pr) = &h.pr {
        lines.push(format!("pr: {}", yaml_scalar(pr)));
    }
    if let Some(ticket) = &h.ticket {
        lines.push(format!("ticket: {}", yaml_scalar(ticket)));
    }
    lines.push(format!("status: {}", h.status.as_str()));
    lines.push("---".to_string());
    lines.push(String::new());
    let header = lines.join("\n");
    let clean_body = h.body.trim_end_matches('\n');
    format!("{header}{clean_body}\n")
}

/// Parse the flat YAML frontmatter block and markdown body of a handoff file.
#[must_use]
pub fn parse_frontmatter(content: &str) -> Option<(HashMap<String, String>, String)> {
    let normalized = content.replace("\r\n", "\n");
    let after_open = normalized.strip_prefix("---\n")?;
    let (block, body_raw) = if let Some(idx) = after_open.find("\n---\n") {
        (&after_open[..idx], &after_open[idx + 5..])
    } else if let Some(stripped) = after_open.strip_suffix("\n---") {
        (stripped, "")
    } else {
        return None;
    };

    let mut data = HashMap::new();
    for line in block.lines() {
        let no_comment = match line.find(" #") {
            Some(idx) => &line[..idx],
            None => line,
        };
        if no_comment.trim().is_empty() {
            continue;
        }
        let Some((key_raw, val_raw)) = no_comment.split_once(':') else {
            continue;
        };
        let key = key_raw.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let raw = val_raw.trim();
        let val = if raw.is_empty() || raw == "[]" {
            String::new()
        } else {
            raw.strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .or_else(|| raw.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
                .unwrap_or(raw)
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
        };
        data.insert(key.to_string(), val);
    }

    Some((data, body_raw.trim_end_matches('\n').to_string()))
}

/// Validate and convert parsed frontmatter + body into a [`Handoff`].
///
/// # Errors
///
/// Returns a [`CliError`] (`usage`, exit code 2) if required fields are missing or invalid.
pub fn to_handoff(
    frontmatter: &HashMap<String, String>,
    body: &str,
    file_basename: &str,
) -> Result<Handoff, CliError> {
    let id = frontmatter
        .get("id")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CliError::usage(format!("missing id in {file_basename}"), ""))?
        .clone();
    let date = frontmatter
        .get("date")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CliError::usage(format!("missing date in {file_basename}"), ""))?
        .clone();
    let title = frontmatter
        .get("title")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CliError::usage(format!("missing title in {file_basename}"), ""))?
        .clone();
    let status_str = frontmatter.get("status").map_or("", String::as_str);
    let status = match status_str {
        "active" => HandoffStatus::Active,
        "resolved" => HandoffStatus::Resolved,
        other => {
            return Err(CliError::usage(
                format!("invalid status \"{other}\" in {file_basename} (expected active|resolved)"),
                "",
            ));
        }
    };
    let pr = frontmatter.get("pr").filter(|s| !s.is_empty()).cloned();
    let ticket = frontmatter.get("ticket").filter(|s| !s.is_empty()).cloned();

    Ok(Handoff {
        id,
        date,
        pr,
        ticket,
        title,
        status,
        body: body.trim_end_matches('\n').to_string(),
    })
}

/// Emit the markdown section skeleton for a new handoff (`--skeleton`).
#[must_use]
pub fn handoff_body_skeleton(pr: Option<&str>, ticket: Option<&str>) -> String {
    let mut lines: Vec<String> = vec![
        "## What landed".to_string(),
        String::new(),
        "<!-- one-line summary of what shipped; frontmatter holds pr/ticket -->".to_string(),
        String::new(),
    ];
    let refs: Vec<&str> = [ticket, pr]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect();
    if !refs.is_empty() {
        lines.push(format!("ref: {}", refs.join(" / ")));
        lines.push(String::new());
    }
    lines.push("## Verification".to_string());
    lines.push(String::new());
    lines.push("- [ ] `bun run typecheck` clean".to_string());
    lines.push(String::new());
    lines.push("- [ ] `bun test` passes (N before → N+M after)".to_string());
    lines.push(String::new());
    lines.push("- [ ] `bun build` + `linearctl <verb> --help` run".to_string());
    lines.push(String::new());
    lines.push("## Decisions".to_string());
    lines.push(String::new());
    lines.push("<!-- operator decisions made this session, with rationale -->".to_string());
    lines.push(String::new());
    lines.push("## Next steps".to_string());
    lines.push(String::new());
    lines.push("<!-- what the next session should do first -->".to_string());
    lines.push(String::new());
    format!("{}\n", lines.join("\n"))
}

/// Return the list of required section headings missing from `body`.
#[must_use]
pub fn missing_sections(body: &str) -> Vec<&'static str> {
    HANDOFF_SECTIONS
        .iter()
        .copied()
        .filter(|&h| !body.contains(h))
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn serializes_and_parses_handoff_round_trip() {
        let h = Handoff {
            id: handoff_id("OAuth Scaffolding", "2026-07-28"),
            date: "2026-07-28".to_string(),
            pr: Some("#112".to_string()),
            ticket: Some("CER-1148".to_string()),
            title: "OAuth Scaffolding".to_string(),
            status: HandoffStatus::Active,
            body: handoff_body_skeleton(Some("#112"), Some("CER-1148"))
                .trim_end_matches('\n')
                .to_string(),
        };
        assert_eq!(h.id, "2026-07-28-oauth-scaffolding");
        assert!(missing_sections(&h.body).is_empty());

        let raw = serialize_handoff(&h);
        let (fm, body) = parse_frontmatter(&raw).unwrap();
        let parsed = to_handoff(&fm, &body, "2026-07-28-oauth-scaffolding.md").unwrap();
        assert_eq!(parsed, h);
    }
}
