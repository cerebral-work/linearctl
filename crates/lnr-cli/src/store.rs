//! Local filesystem state adapters (`handoff`, `template`, `loops`, `beads`).
//!
//! All directory lookups support both `lnr` and legacy `linearctl` paths.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use lnr_domain::beads::{BeadsIssue, BeadsMetadata};
use lnr_domain::error::CliError;
use lnr_domain::handoff::{
    handoff_id, missing_sections, parse_frontmatter, serialize_handoff, to_handoff, Handoff,
    HandoffStatus, NewHandoff,
};
use lnr_domain::loops::{parse_loop_recipe, LoopRecipe};
use lnr_domain::template::{parse_template, ParsedTemplate};
use lnr_domain::time::{epoch_ms_to_date, epoch_ms_to_iso};
use serde::{Deserialize, Serialize};

/// Return the current epoch timestamp in milliseconds.
#[must_use]
pub fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Return the current UTC timestamp in ISO-8601 format.
#[must_use]
pub fn now_iso() -> String {
    epoch_ms_to_iso(now_epoch_ms())
}

/// Return the current UTC date (`YYYY-MM-DD`).
#[must_use]
pub fn now_date() -> String {
    epoch_ms_to_date(now_epoch_ms())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// Handoff Store
// ---------------------------------------------------------------------------

/// Return the primary handoff directory (`LINEARCTL_HANDOFF_DIR` or `~/.local/state/linearctl/handoffs`).
#[must_use]
pub fn handoff_write_dir(store_override: Option<&str>) -> PathBuf {
    if let Some(ov) = store_override.map(str::trim).filter(|s| !s.is_empty()) {
        return PathBuf::from(ov);
    }
    if let Ok(override_dir) = std::env::var("LINEARCTL_HANDOFF_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(override_dir) = std::env::var("LNR_HANDOFF_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let base = std::env::var("XDG_STATE_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".local").join("state")))
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("linearctl").join("handoffs")
}

/// Return all candidate handoff directories (`~/.local/state/lnr/handoffs` and `~/.local/state/linearctl/handoffs`).
#[must_use]
pub fn handoff_read_dirs(store_override: Option<&str>) -> Vec<PathBuf> {
    if let Some(ov) = store_override.map(str::trim).filter(|s| !s.is_empty()) {
        return vec![PathBuf::from(ov)];
    }
    if let Ok(override_dir) = std::env::var("LINEARCTL_HANDOFF_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return vec![PathBuf::from(trimmed)];
        }
    }
    if let Ok(override_dir) = std::env::var("LNR_HANDOFF_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return vec![PathBuf::from(trimmed)];
        }
    }
    let base = std::env::var("XDG_STATE_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".local").join("state")))
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    vec![
        base.join("linearctl").join("handoffs"),
        base.join("lnr").join("handoffs"),
    ]
}

/// Write a new handoff markdown file and return the persisted [`Handoff`] plus its path.
pub fn write_handoff(
    input: &NewHandoff,
    strict_sections: bool,
    store_override: Option<&str>,
) -> Result<(Handoff, PathBuf), CliError> {
    if strict_sections {
        let missing = missing_sections(&input.body);
        if !missing.is_empty() {
            return Err(CliError::usage(
                format!(
                    "handoff body is missing required sections: {}",
                    missing.join(", ")
                ),
                "Run `linearctl handoff create --skeleton` to inspect the required section layout.",
            ));
        }
    }
    let date = now_date();
    let id = handoff_id(&input.title, &date);
    let handoff = Handoff {
        id: id.clone(),
        date,
        pr: input.pr.clone(),
        ticket: input.ticket.clone(),
        title: input.title.trim().to_string(),
        status: HandoffStatus::Active,
        body: input.body.trim_end_matches('\n').to_string(),
    };
    let dir = handoff_write_dir(store_override);
    fs::create_dir_all(&dir).map_err(|e| {
        CliError::other(
            format!("failed creating handoff directory {}: {e}", dir.display()),
            "",
        )
    })?;
    let path = dir.join(format!("{id}.md"));
    fs::write(&path, serialize_handoff(&handoff)).map_err(|e| {
        CliError::other(
            format!("failed writing handoff {}: {e}", path.display()),
            "",
        )
    })?;
    Ok((handoff, path))
}

/// List all persisted handoffs sorted newest-first.
pub fn list_handoffs(
    status_filter: Option<HandoffStatus>,
    store_override: Option<&str>,
) -> Result<Vec<(Handoff, PathBuf)>, CliError> {
    let mut seen: BTreeMap<String, (Handoff, PathBuf)> = BTreeMap::new();
    for dir in handoff_read_dirs(store_override) {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(fname) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            let Some((fields, body)) = parse_frontmatter(&raw) else {
                continue;
            };
            let Ok(h) = to_handoff(&fields, &body, fname) else {
                continue;
            };
            if let Some(st) = status_filter {
                if h.status != st {
                    continue;
                }
            }
            seen.entry(h.id.clone()).or_insert((h, path));
        }
    }
    let mut list: Vec<(Handoff, PathBuf)> = seen.into_values().collect();
    list.sort_by(|a, b| b.0.date.cmp(&a.0.date).then_with(|| b.0.id.cmp(&a.0.id)));
    Ok(list)
}

/// Find a handoff by exact ID or unique prefix.
pub fn find_handoff(
    id_or_prefix: &str,
    store_override: Option<&str>,
) -> Result<(Handoff, PathBuf), CliError> {
    let all = list_handoffs(None, store_override)?;
    let needle = id_or_prefix.trim();
    if let Some(exact) = all.iter().find(|(h, _)| h.id == needle) {
        return Ok(exact.clone());
    }
    let prefix_matches: Vec<(Handoff, PathBuf)> = all
        .into_iter()
        .filter(|(h, _)| h.id.starts_with(needle))
        .collect();
    match prefix_matches.len() {
        0 => Err(CliError::not_found(
            format!("handoff '{needle}' not found"),
            "Run: linearctl handoff list",
        )),
        1 => prefix_matches
            .into_iter()
            .next()
            .ok_or_else(|| CliError::not_found(format!("handoff '{needle}' not found"), "")),
        _ => Err(CliError::usage(
            format!("handoff prefix '{needle}' is ambiguous"),
            "Provide a longer handoff ID prefix.",
        )),
    }
}

/// Update the status of an existing handoff on disk.
pub fn update_handoff_status(
    id_or_prefix: &str,
    next_status: HandoffStatus,
    store_override: Option<&str>,
) -> Result<(Handoff, PathBuf), CliError> {
    let (mut h, path) = find_handoff(id_or_prefix, store_override)?;
    h.status = next_status;
    fs::write(&path, serialize_handoff(&h)).map_err(|e| {
        CliError::other(
            format!("failed updating handoff {}: {e}", path.display()),
            "",
        )
    })?;
    Ok((h, path))
}

// ---------------------------------------------------------------------------
// Template Store
// ---------------------------------------------------------------------------

/// Loaded template with its source path and scope (`project` or `user`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTemplate {
    /// Parsed template metadata and body.
    #[serde(flatten)]
    pub template: ParsedTemplate,
    /// Scope where the template was found (`project` or `user`).
    pub scope: String,
    /// Filesystem path to the `.md` template file.
    pub path: String,
}

fn template_search_dirs() -> Vec<(String, PathBuf)> {
    if let Ok(override_dir) = std::env::var("LINEARCTL_TEMPLATE_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return vec![("project".to_string(), PathBuf::from(trimmed))];
        }
    }
    let mut dirs = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(("project".to_string(), cwd.join(".lnr").join("templates")));
        dirs.push((
            "project".to_string(),
            cwd.join(".linearctl").join("templates"),
        ));
    }
    if let Some(home) = home_dir() {
        let cfg = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        dirs.push(("user".to_string(), cfg.join("lnr").join("templates")));
        dirs.push(("user".to_string(), cfg.join("linearctl").join("templates")));
    }
    dirs
}

/// Discover all issue templates across project and user directories (project overrides user).
pub fn list_templates() -> Result<Vec<StoredTemplate>, CliError> {
    let mut map: BTreeMap<String, StoredTemplate> = BTreeMap::new();
    for (scope, dir) in template_search_dirs() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let raw = fs::read_to_string(&path).map_err(|e| {
                CliError::other(
                    format!("failed reading template {}: {e}", path.display()),
                    "",
                )
            })?;
            let parsed = parse_template(&raw, stem)?;
            map.entry(parsed.name.clone())
                .or_insert_with(|| StoredTemplate {
                    template: parsed,
                    scope: scope.clone(),
                    path: path.display().to_string(),
                });
        }
    }
    Ok(map.into_values().collect())
}

/// Load a template by name or path.
pub fn load_template(name_or_path: &str) -> Result<StoredTemplate, CliError> {
    let direct = Path::new(name_or_path);
    if direct.exists() && direct.is_file() {
        let raw = fs::read_to_string(direct).map_err(|e| {
            CliError::other(
                format!("failed reading template {}: {e}", direct.display()),
                "",
            )
        })?;
        let stem = direct
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("template");
        let parsed = parse_template(&raw, stem)?;
        return Ok(StoredTemplate {
            template: parsed,
            scope: "file".to_string(),
            path: direct.display().to_string(),
        });
    }
    let all = list_templates()?;
    let needle = name_or_path.trim();
    if let Some(found) = all.into_iter().find(|t| t.template.name == needle) {
        return Ok(found);
    }
    Err(CliError::not_found(
        format!("template '{needle}' not found"),
        "Run: linearctl template list",
    ))
}

// ---------------------------------------------------------------------------
// Loop Recipe Store
// ---------------------------------------------------------------------------

/// Loaded loop recipe with its source path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredLoopRecipe {
    /// Parsed recipe.
    #[serde(flatten)]
    pub recipe: LoopRecipe,
    /// Path to the recipe file.
    pub path: String,
}

fn loop_search_dirs() -> Vec<PathBuf> {
    if let Ok(override_dir) = std::env::var("LINEARCTL_LOOP_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return vec![PathBuf::from(trimmed)];
        }
    }
    let mut dirs = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join(".lnr").join("loops"));
        dirs.push(cwd.join(".linearctl").join("loops"));
        dirs.push(cwd.join("recipes"));
    }
    if let Some(home) = home_dir() {
        let cfg = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        dirs.push(cfg.join("lnr").join("loops"));
        dirs.push(cfg.join("linearctl").join("loops"));
    }
    dirs
}

/// Discover all `.md` loop recipes across search directories.
pub fn list_loop_recipes() -> Result<Vec<StoredLoopRecipe>, CliError> {
    let mut map: BTreeMap<String, StoredLoopRecipe> = BTreeMap::new();
    for dir in loop_search_dirs() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            let path_str = path.display().to_string();
            let Some(recipe) = parse_loop_recipe(&raw, &path_str) else {
                continue;
            };
            let key = recipe.name.clone().unwrap_or_else(|| path_str.clone());
            map.entry(key).or_insert(StoredLoopRecipe {
                recipe,
                path: path_str,
            });
        }
    }
    Ok(map.into_values().collect())
}

/// Load a loop recipe by name or `.md` file path.
pub fn load_loop_recipe(name_or_path: &str) -> Result<StoredLoopRecipe, CliError> {
    let direct = Path::new(name_or_path);
    if direct.exists() && direct.is_file() {
        let raw = fs::read_to_string(direct).map_err(|e| {
            CliError::other(
                format!("failed reading recipe {}: {e}", direct.display()),
                "",
            )
        })?;
        let path_str = direct.display().to_string();
        let recipe = parse_loop_recipe(&raw, &path_str).ok_or_else(|| {
            CliError::usage(
                format!("recipe {} is missing YAML frontmatter", direct.display()),
                "",
            )
        })?;
        return Ok(StoredLoopRecipe {
            recipe,
            path: path_str,
        });
    }
    let all = list_loop_recipes()?;
    let needle = name_or_path.trim();
    if let Some(found) = all
        .into_iter()
        .find(|r| r.recipe.name.as_deref() == Some(needle))
    {
        return Ok(found);
    }
    Err(CliError::not_found(
        format!("loop recipe '{needle}' not found"),
        "Run: linearctl loops lint",
    ))
}

// ---------------------------------------------------------------------------
// Beads Local Store (.beads/issues.jsonl + .beads/metadata.json)
// ---------------------------------------------------------------------------

/// Return the `.beads` directory in the current working directory.
#[must_use]
pub fn beads_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("LINEARCTL_BEADS_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".beads")
}

/// Load all issues from `.beads/issues.jsonl`.
pub fn load_beads_issues() -> Result<Vec<BeadsIssue>, CliError> {
    let path = beads_dir().join("issues.jsonl");
    if !path.exists() {
        return Err(CliError::not_found(
            format!("Beads store not found at {}", path.display()),
            "Run: linearctl beads init --project <name>",
        ));
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| CliError::other(format!("failed reading {}: {e}", path.display()), ""))?;
    let mut issues = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: BeadsIssue = serde_json::from_str(trimmed).map_err(|e| {
            CliError::usage(
                format!("malformed JSONL at {}:{}: {e}", path.display(), idx + 1),
                "",
            )
        })?;
        issues.push(parsed);
    }
    Ok(issues)
}

/// Save all issues to `.beads/issues.jsonl` and optional metadata to `.beads/metadata.json`.
pub fn save_beads_issues(
    issues: &[BeadsIssue],
    meta: Option<&BeadsMetadata>,
) -> Result<PathBuf, CliError> {
    let dir = beads_dir();
    fs::create_dir_all(&dir)
        .map_err(|e| CliError::other(format!("failed creating {}: {e}", dir.display()), ""))?;
    let jsonl_path = dir.join("issues.jsonl");
    let mut buf = String::new();
    for issue in issues {
        let line = serde_json::to_string(issue).map_err(|e| {
            CliError::other(
                format!("failed serializing Beads issue {}: {e}", issue.id),
                "",
            )
        })?;
        buf.push_str(&line);
        buf.push('\n');
    }
    fs::write(&jsonl_path, buf).map_err(|e| {
        CliError::other(format!("failed writing {}: {e}", jsonl_path.display()), "")
    })?;
    if let Some(m) = meta {
        let meta_path = dir.join("metadata.json");
        let meta_json = serde_json::to_string_pretty(m).unwrap_or_else(|_| "{}".to_string());
        let _ = fs::write(meta_path, meta_json);
    }
    Ok(jsonl_path)
}
