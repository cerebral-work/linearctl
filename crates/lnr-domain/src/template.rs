//! Issue template parsing, variable inspection, and `{{ var | "default" }}` substitution.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::CliError;

/// Parsed issue template (`--- ... ---` frontmatter plus markdown body).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedTemplate {
    /// Template name (`frontmatter.name` or filename stem fallback).
    pub name: String,
    /// Issue title template (may contain `{{ var }}` placeholders).
    pub title: String,
    /// Default label names attached when filing from this template.
    pub labels: Vec<String>,
    /// Markdown body template.
    pub body: String,
}

/// Variable referenced by a [`ParsedTemplate`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateVarSpec {
    /// Variable identifier.
    pub name: String,
    /// Optional default value (`{{ name | "default" }}`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

/// Rendered title and description produced by [`render_template`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderedTemplate {
    /// Substituted issue title.
    pub title: String,
    /// Substituted markdown description (`None` when the rendered body is empty).
    pub description: Option<String>,
}

fn is_ident_key(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphanumeric() || first == '_') {
        return false;
    };
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_var_name(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Parse a markdown issue template with a `---` frontmatter block.
///
/// # Errors
///
/// Returns a [`CliError`] (`usage`, exit code 2) if the frontmatter is missing, malformed, or lacks `title:`.
pub fn parse_template(raw: &str, fallback_name: &str) -> Result<ParsedTemplate, CliError> {
    let Some(after_open) = raw.strip_prefix("---\n") else {
        return Err(CliError::usage(
            "template has no frontmatter block (--- … ---).",
            "",
        ));
    };

    let (fm_block, body_raw) = if let Some(idx) = after_open.find("\n---\n") {
        (&after_open[..idx], &after_open[idx + 5..])
    } else if let Some(stripped) = after_open.strip_suffix("\n---") {
        (stripped, "")
    } else {
        return Err(CliError::usage(
            "template has no frontmatter block (--- … ---).",
            "",
        ));
    };

    let mut fields: HashMap<String, String> = HashMap::new();
    for line in fm_block.lines() {
        let trimmed_start = line.trim_start();
        if trimmed_start.is_empty() || trimmed_start.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once(':') else {
            let quoted = serde_json::to_string(line).unwrap_or_else(|_| format!("\"{line}\""));
            return Err(CliError::usage(
                format!("bad frontmatter line: {quoted}"),
                "",
            ));
        };
        if !is_ident_key(k) {
            let quoted = serde_json::to_string(line).unwrap_or_else(|_| format!("\"{line}\""));
            return Err(CliError::usage(
                format!("bad frontmatter line: {quoted}"),
                "",
            ));
        }
        fields.insert(k.to_string(), v.trim().to_string());
    }

    let raw_title = fields.get("title").map(|t| {
        t.strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .unwrap_or(t)
            .to_string()
    });
    let Some(title) = raw_title.filter(|t| !t.is_empty()) else {
        return Err(CliError::usage(
            "template frontmatter needs a `title:` field.",
            "",
        ));
    };

    let labels_raw = fields.get("labels").map_or("", String::as_str);
    let labels_inner = labels_raw
        .strip_prefix('[')
        .unwrap_or(labels_raw)
        .strip_suffix(']')
        .unwrap_or(labels_raw);
    let labels: Vec<String> = labels_inner
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    let name = fields
        .get("name")
        .cloned()
        .unwrap_or_else(|| fallback_name.to_string());

    Ok(ParsedTemplate {
        name,
        title,
        labels,
        body: body_raw.trim().to_string(),
    })
}

/// Parse one `{{ name }}` or `{{ name | "default" }}` inner expression.
fn parse_var_placeholder(inner: &str) -> Option<(String, Option<String>)> {
    let trimmed = inner.trim();
    if let Some((left, right)) = trimmed.split_once('|') {
        let name = left.trim();
        if !is_var_name(name) {
            return None;
        }
        let right_trimmed = right.trim();
        let def = right_trimmed.strip_prefix('"')?.strip_suffix('"')?;
        if def.contains('"') {
            return None;
        }
        Some((name.to_string(), Some(def.to_string())))
    } else {
        if !is_var_name(trimmed) {
            return None;
        }
        Some((trimmed.to_string(), None))
    }
}

fn scan_placeholders(text: &str) -> Vec<(usize, usize, String, Option<String>)> {
    let mut out = Vec::new();
    let mut cursor = 0;
    while let Some(rel_open) = text[cursor..].find("{{") {
        let start = cursor + rel_open;
        let after_open = start + 2;
        if let Some(rel_close) = text[after_open..].find("}}") {
            let end = after_open + rel_close + 2;
            let inner = &text[after_open..after_open + rel_close];
            if let Some((name, def)) = parse_var_placeholder(inner) {
                out.push((start, end, name, def));
                cursor = end;
                continue;
            }
        }
        cursor = after_open;
    }
    out
}

/// Extract every distinct variable referenced in `title` and `body`, preserving declaration order.
#[must_use]
pub fn template_vars(t: &ParsedTemplate) -> Vec<TemplateVarSpec> {
    let mut order: Vec<String> = Vec::new();
    let mut defaults: HashMap<String, Option<String>> = HashMap::new();

    for text in [&t.title, &t.body] {
        for (_, _, name, def) in scan_placeholders(text) {
            if let Some(existing) = defaults.get_mut(&name) {
                if existing.is_none() && def.is_some() {
                    *existing = def;
                }
            } else {
                order.push(name.clone());
                defaults.insert(name, def);
            }
        }
    }

    order
        .into_iter()
        .map(|name| {
            let default = defaults.remove(&name).flatten();
            TemplateVarSpec { name, default }
        })
        .collect()
}

fn substitute_text(text: &str, vars: &HashMap<String, String>) -> String {
    let matches = scan_placeholders(text);
    if matches.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (start, end, name, def) in matches {
        out.push_str(&text[last..start]);
        let replacement = vars
            .get(&name)
            .map(String::as_str)
            .or(def.as_deref())
            .unwrap_or("");
        out.push_str(replacement);
        last = end;
    }
    out.push_str(&text[last..]);
    out
}

/// Substitute variables into `t.title` and `t.body`.
///
/// # Errors
///
/// Returns a [`CliError`] (`usage`, exit code 2) listing every missing required variable.
pub fn render_template(
    t: &ParsedTemplate,
    vars: &HashMap<String, String>,
) -> Result<RenderedTemplate, CliError> {
    let missing: Vec<String> = template_vars(t)
        .into_iter()
        .filter(|v| !vars.contains_key(&v.name) && v.default.is_none())
        .map(|v| v.name)
        .collect();

    if let Some(first) = missing.first() {
        return Err(CliError::usage(
            format!(
                "missing template variable(s): {} — pass --var {first}=…",
                missing.join(", ")
            ),
            "",
        ));
    }

    let title = substitute_text(&t.title, vars);
    let desc = substitute_text(&t.body, vars);
    Ok(RenderedTemplate {
        title,
        description: (!desc.is_empty()).then_some(desc),
    })
}

/// Parse repeatable `--var key=value` flags into a key-value map.
///
/// # Errors
///
/// Returns a [`CliError`] (`usage`, exit code 2) if any flag lacks a non-empty `key=`.
pub fn parse_var_flags<S: AsRef<str>>(flags: &[S]) -> Result<HashMap<String, String>, CliError> {
    let mut out = HashMap::new();
    for flag in flags {
        let f = flag.as_ref();
        let Some((k, v)) = f.split_once('=') else {
            let quoted = serde_json::to_string(f).unwrap_or_else(|_| format!("\"{f}\""));
            return Err(CliError::usage(
                format!("--var expects key=value, got {quoted}."),
                "",
            ));
        };
        if k.is_empty() {
            let quoted = serde_json::to_string(f).unwrap_or_else(|_| format!("\"{f}\""));
            return Err(CliError::usage(
                format!("--var expects key=value, got {quoted}."),
                "",
            ));
        }
        out.insert(k.to_string(), v.to_string());
    }
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_renders_template_variables() {
        let raw = "---\ntitle: \"[{{ service }}] {{ summary }}\"\nlabels: [bug, triage]\n---\n\nHost: {{ host | \"ceres\" }}\nDetails: {{ summary }}\n";
        let parsed = parse_template(raw, "incident").unwrap();
        assert_eq!(parsed.name, "incident");
        assert_eq!(parsed.labels, vec!["bug", "triage"]);

        let vars = template_vars(&parsed);
        assert_eq!(vars.len(), 3);
        assert_eq!(vars[0].name, "service");
        assert_eq!(vars[2].default, Some("ceres".to_string()));

        let err = render_template(&parsed, &HashMap::new()).unwrap_err();
        assert!(err.message.contains("service, summary"));

        let supplied = parse_var_flags(&["service=auth", "summary=login 500"]).unwrap();
        let rendered = render_template(&parsed, &supplied).unwrap();
        assert_eq!(rendered.title, "[auth] login 500");
        assert_eq!(
            rendered.description.unwrap(),
            "Host: ceres\nDetails: login 500"
        );
    }
}
