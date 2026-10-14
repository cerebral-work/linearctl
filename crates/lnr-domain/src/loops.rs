//! Linear Loop recipe parser and static linter (`lnr loops lint`).

use serde::{Deserialize, Serialize};

use crate::time::{iso_to_epoch_ms, MS_PER_DAY};

/// Trigger specification for a [`LoopRecipe`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopTrigger {
    /// Trigger event type (`issue_created`, `issue_updated`, `issue_created_or_updated`, `schedule`).
    #[serde(rename = "type")]
    pub trigger_type: String,
    /// Optional cron schedule expression (required when `trigger_type == "schedule"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    /// Optional timezone name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

/// Permissions specification for a [`LoopRecipe`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopPermissions {
    /// Accessible team keys (`None` if omitted, `Some(vec)` if declared).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_access: Option<Vec<String>>,
    /// Whether code intelligence is enabled.
    pub code_intelligence: bool,
    /// Whether autonomous coding sessions are enabled.
    pub coding_sessions: bool,
    /// Whether external web access is enabled.
    pub web_access: bool,
    /// External source names.
    #[serde(default)]
    pub external_sources: Vec<String>,
    /// Whether the loop may mutate issues outside the triggering issue.
    pub allow_changes_outside_triggering_issue: bool,
}

/// Parsed Linear Loop recipe document.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopRecipe {
    /// Recipe name.
    pub name: Option<String>,
    /// Schema/recipe version number.
    pub version: Option<i64>,
    /// Date last verified against the Linear UI (`YYYY-MM-DD`).
    pub last_verified: Option<String>,
    /// Trigger configuration.
    pub trigger: Option<LoopTrigger>,
    /// Permission configuration.
    pub permissions: Option<LoopPermissions>,
    /// Declared tools list.
    #[serde(default)]
    pub tools: Vec<String>,
    /// Declared audience list.
    #[serde(default)]
    pub audience: Vec<String>,
    /// Markdown body below the frontmatter.
    pub body: String,
    /// Source file path.
    pub file: String,
}

/// Severity of a [`LintFinding`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LintSeverity {
    /// Blocking recipe error.
    Error,
    /// Non-blocking recipe warning.
    Warning,
}

/// Single lint finding emitted by [`lint_recipe`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LintFinding {
    /// Source file path.
    pub file: String,
    /// Recipe name (or file path fallback).
    pub recipe: String,
    /// Severity level (`error` or `warning`).
    pub severity: LintSeverity,
    /// Diagnostic message.
    pub message: String,
}

/// Aggregated result of linting loop recipes across directories.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LintResult {
    /// All parsed recipes.
    pub recipes: Vec<LoopRecipe>,
    /// All lint findings.
    pub findings: Vec<LintFinding>,
    /// True if there are zero `error`-severity findings.
    pub valid: bool,
}

const VALID_TRIGGER_TYPES: &[&str] = &[
    "issue_created",
    "issue_updated",
    "issue_created_or_updated",
    "schedule",
];

/// Parse a markdown loop recipe with YAML frontmatter.
#[must_use]
pub fn parse_loop_recipe(content: &str, file: &str) -> Option<LoopRecipe> {
    let normalized = content.replace("\r\n", "\n");
    let after_open = normalized.strip_prefix("---\n")?;
    let (block, body) = if let Some(idx) = after_open.find("\n---\n") {
        (&after_open[..idx], &after_open[idx + 5..])
    } else if let Some(stripped) = after_open.strip_suffix("\n---") {
        (stripped, "")
    } else {
        return None;
    };

    let mut recipe = LoopRecipe {
        body: body.to_string(),
        file: file.to_string(),
        ..Default::default()
    };

    let mut parent_section = "";
    let mut list_target = "";

    for line in block.lines() {
        let no_comment = match line.find(" #") {
            Some(idx) => &line[..idx],
            None => line,
        };
        if no_comment.trim().is_empty() {
            continue;
        }
        let indent = no_comment.chars().take_while(|c| c.is_whitespace()).count();
        let trimmed = no_comment.trim();

        if let Some(item_raw) = trimmed.strip_prefix("- ") {
            let item = item_raw
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            match (parent_section, list_target) {
                ("permissions", "team_access") => {
                    if let Some(perms) = &mut recipe.permissions {
                        perms.team_access.get_or_insert_with(Vec::new).push(item);
                    }
                }
                ("permissions", "external_sources") => {
                    if let Some(perms) = &mut recipe.permissions {
                        perms.external_sources.push(item);
                    }
                }
                (_, "tools") => recipe.tools.push(item),
                (_, "audience") => recipe.audience.push(item),
                _ => {}
            }
            continue;
        }

        let Some((key_raw, val_raw)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key_raw.trim();
        let val = val_raw
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string();

        if indent == 0 {
            parent_section = "";
            list_target = "";
            match key {
                "name" if !val.is_empty() => recipe.name = Some(val),
                "version" => recipe.version = val.parse::<i64>().ok(),
                "last_verified" if !val.is_empty() => recipe.last_verified = Some(val),
                "trigger" => {
                    recipe.trigger = Some(LoopTrigger::default());
                    parent_section = "trigger";
                }
                "permissions" => {
                    recipe.permissions = Some(LoopPermissions::default());
                    parent_section = "permissions";
                }
                "tools" => {
                    parent_section = "root";
                    list_target = "tools";
                }
                "audience" => {
                    parent_section = "root";
                    list_target = "audience";
                }
                _ => {}
            }
        } else {
            match (parent_section, key) {
                ("trigger", "type") => {
                    if let Some(t) = &mut recipe.trigger {
                        t.trigger_type = val;
                    }
                }
                ("trigger", "cron") => {
                    if let Some(t) = &mut recipe.trigger {
                        if !val.is_empty() {
                            t.cron = Some(val);
                        }
                    }
                }
                ("trigger", "timezone") => {
                    if let Some(t) = &mut recipe.trigger {
                        if !val.is_empty() {
                            t.timezone = Some(val);
                        }
                    }
                }
                ("permissions", "team_access") => {
                    list_target = "team_access";
                    if let Some(perms) = &mut recipe.permissions {
                        if val == "[]" || val.is_empty() {
                            perms.team_access = Some(Vec::new());
                        }
                    }
                }
                ("permissions", "external_sources") => {
                    list_target = "external_sources";
                }
                ("permissions", "code_intelligence") => {
                    if let Some(perms) = &mut recipe.permissions {
                        perms.code_intelligence = val == "true";
                    }
                }
                ("permissions", "coding_sessions") => {
                    if let Some(perms) = &mut recipe.permissions {
                        perms.coding_sessions = val == "true";
                    }
                }
                ("permissions", "web_access") => {
                    if let Some(perms) = &mut recipe.permissions {
                        perms.web_access = val == "true";
                    }
                }
                ("permissions", "allow_changes_outside_triggering_issue") => {
                    if let Some(perms) = &mut recipe.permissions {
                        perms.allow_changes_outside_triggering_issue = val == "true";
                    }
                }
                _ => {}
            }
        }
    }

    Some(recipe)
}

/// Lint a single [`LoopRecipe`] against the 9 catalog rules.
#[must_use]
pub fn lint_recipe(recipe: &LoopRecipe, file: &str, now_ms: i64) -> Vec<LintFinding> {
    let mut findings = Vec::new();
    let name = recipe.name.as_deref().unwrap_or(file).to_string();

    if recipe.name.as_deref().unwrap_or("").is_empty() {
        findings.push(LintFinding {
            file: file.to_string(),
            recipe: name.clone(),
            severity: LintSeverity::Error,
            message: "missing required field: name".to_string(),
        });
    }
    if recipe.version.is_none() {
        findings.push(LintFinding {
            file: file.to_string(),
            recipe: name.clone(),
            severity: LintSeverity::Error,
            message: "missing required field: version".to_string(),
        });
    }
    if recipe.last_verified.as_deref().unwrap_or("").is_empty() {
        findings.push(LintFinding {
            file: file.to_string(),
            recipe: name.clone(),
            severity: LintSeverity::Warning,
            message: "missing last_verified date — staleness is invisible without it".to_string(),
        });
    }
    if recipe.trigger.is_none() {
        findings.push(LintFinding {
            file: file.to_string(),
            recipe: name.clone(),
            severity: LintSeverity::Error,
            message: "missing required field: trigger".to_string(),
        });
    }
    if recipe.permissions.is_none() {
        findings.push(LintFinding {
            file: file.to_string(),
            recipe: name.clone(),
            severity: LintSeverity::Error,
            message: "missing required field: permissions".to_string(),
        });
    }

    if let Some(trigger) = &recipe.trigger {
        if !VALID_TRIGGER_TYPES.contains(&trigger.trigger_type.as_str()) {
            findings.push(LintFinding {
                file: file.to_string(),
                recipe: name.clone(),
                severity: LintSeverity::Error,
                message: format!(
                    "invalid trigger type: {} (expected one of {})",
                    trigger.trigger_type,
                    VALID_TRIGGER_TYPES.join(", ")
                ),
            });
        }
        if trigger.trigger_type == "schedule" && trigger.cron.as_deref().unwrap_or("").is_empty() {
            findings.push(LintFinding {
                file: file.to_string(),
                recipe: name.clone(),
                severity: LintSeverity::Error,
                message: "schedule trigger requires a cron field".to_string(),
            });
        }
    }

    if let Some(perms) = &recipe.permissions {
        if let Some(teams) = &perms.team_access {
            if teams.is_empty() {
                findings.push(LintFinding {
                    file: file.to_string(),
                    recipe: name.clone(),
                    severity: LintSeverity::Warning,
                    message: "team_access is empty — loop has no team scope".to_string(),
                });
            }
        }
        if perms.web_access {
            findings.push(LintFinding {
                file: file.to_string(),
                recipe: name.clone(),
                severity: LintSeverity::Warning,
                message:
                    "web_access is enabled — this can send workspace content to external services"
                        .to_string(),
            });
        }
        if perms.coding_sessions {
            findings.push(LintFinding {
                file: file.to_string(),
                recipe: name.clone(),
                severity: LintSeverity::Warning,
                message: "coding_sessions is enabled — loop can start PRs autonomously".to_string(),
            });
        }
        let is_schedule = recipe
            .trigger
            .as_ref()
            .is_some_and(|t| t.trigger_type == "schedule");
        if perms.allow_changes_outside_triggering_issue && !is_schedule {
            findings.push(LintFinding {
                file: file.to_string(),
                recipe: name.clone(),
                severity: LintSeverity::Warning,
                message: "allow_changes_outside_triggering_issue is true on a non-schedule trigger — loop can write to any issue in scope".to_string(),
            });
        }
    }

    if let Some(verified_str) = &recipe.last_verified {
        if let Some(verified_ms) = iso_to_epoch_ms(verified_str) {
            let days_since = (now_ms - verified_ms) / MS_PER_DAY;
            if days_since > 90 {
                findings.push(LintFinding {
                    file: file.to_string(),
                    recipe: name.clone(),
                    severity: LintSeverity::Warning,
                    message: format!(
                        "last_verified is {days_since}d old — re-verify against the Linear Loops UI"
                    ),
                });
            }
        }
    }

    if !recipe.body.is_empty() {
        let lower = recipe.body.to_lowercase();
        if !(lower.contains("do not") || lower.contains("does not") || lower.contains("never")) {
            findings.push(LintFinding {
                file: file.to_string(),
                recipe: name,
                severity: LintSeverity::Warning,
                message: "body has no negative constraints (e.g. 'Do NOT change...') — bound the loop's autonomy".to_string(),
            });
        }
    }

    findings
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_lints_valid_recipe() {
        let md = "---\nname: intake\nversion: 1\nlast_verified: 2026-10-01\ntrigger:\n  type: issue_created\npermissions:\n  team_access:\n    - CER\n  web_access: false\n  coding_sessions: false\n  allow_changes_outside_triggering_issue: false\n---\nDo NOT close issues automatically.\n";
        let recipe = parse_loop_recipe(md, "intake.md").unwrap();
        let now = iso_to_epoch_ms("2026-10-14").unwrap();
        let findings = lint_recipe(&recipe, "intake.md", now);
        assert!(findings.is_empty(), "{findings:?}");
    }
}
