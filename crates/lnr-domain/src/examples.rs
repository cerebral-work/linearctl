//! Embedded runnable shell examples for all 44 `lnr` root commands (`examples/*.sh`).

/// Ordered `(command_name, shell_script)` pairs embedded at compile time.
pub const EXAMPLES: &[(&str, &str)] = &[
    ("whoami", include_str!("../../../examples/whoami.sh")),
    ("digest", include_str!("../../../examples/digest.sh")),
    ("mine", include_str!("../../../examples/mine.sh")),
    (
        "initiative",
        include_str!("../../../examples/initiative.sh"),
    ),
    ("file", include_str!("../../../examples/file.sh")),
    ("comment", include_str!("../../../examples/comment.sh")),
    ("update", include_str!("../../../examples/update.sh")),
    ("close", include_str!("../../../examples/close.sh")),
    ("comments", include_str!("../../../examples/comments.sh")),
    ("triage", include_str!("../../../examples/triage.sh")),
    ("stale", include_str!("../../../examples/stale.sh")),
    ("milestone", include_str!("../../../examples/milestone.sh")),
    ("project", include_str!("../../../examples/project.sh")),
    ("roadmap", include_str!("../../../examples/roadmap.sh")),
    ("xref", include_str!("../../../examples/xref.sh")),
    ("label", include_str!("../../../examples/label.sh")),
    ("park", include_str!("../../../examples/park.sh")),
    ("dupcheck", include_str!("../../../examples/dupcheck.sh")),
    ("search", include_str!("../../../examples/search.sh")),
    ("pull", include_str!("../../../examples/pull.sh")),
    ("show", include_str!("../../../examples/show.sh")),
    ("standup", include_str!("../../../examples/standup.sh")),
    (
        "release-notes",
        include_str!("../../../examples/release-notes.sh"),
    ),
    ("cycle", include_str!("../../../examples/cycle.sh")),
    ("template", include_str!("../../../examples/template.sh")),
    ("link", include_str!("../../../examples/link.sh")),
    ("history", include_str!("../../../examples/history.sh")),
    ("doc", include_str!("../../../examples/doc.sh")),
    ("handoff", include_str!("../../../examples/handoff.sh")),
    ("ratelimit", include_str!("../../../examples/ratelimit.sh")),
    ("loops", include_str!("../../../examples/loops.sh")),
    ("mcp", include_str!("../../../examples/mcp.sh")),
    ("auth", include_str!("../../../examples/auth.sh")),
    ("operator", include_str!("../../../examples/operator.sh")),
    ("watch", include_str!("../../../examples/watch.sh")),
    ("tui", include_str!("../../../examples/tui.sh")),
    ("examples", include_str!("../../../examples/examples.sh")),
    ("backup", include_str!("../../../examples/backup.sh")),
    ("reorg", include_str!("../../../examples/reorg.sh")),
    ("cache", include_str!("../../../examples/cache.sh")),
    ("team", include_str!("../../../examples/team.sh")),
    ("relate", include_str!("../../../examples/relate.sh")),
    ("beads", include_str!("../../../examples/beads.sh")),
    ("plan", include_str!("../../../examples/plan.sh")),
];

/// Look up the embedded shell example script for `command`.
#[must_use]
pub fn get_example(command: &str) -> Option<&'static str> {
    EXAMPLES
        .iter()
        .find_map(|&(name, script)| (name == command).then_some(script))
}

/// Return all registered root command names that have embedded examples.
#[must_use]
pub fn example_command_names() -> Vec<&'static str> {
    EXAMPLES.iter().map(|&(name, _)| name).collect()
}

/// Extract the `# Example: <cmd>` one-line hint from the embedded script for `command`.
#[must_use]
pub fn example_hint(command: &str) -> String {
    let Some(script) = get_example(command) else {
        return "linearctl --help".to_string();
    };
    for line in script.lines() {
        if let Some(rest) = line.strip_prefix("# Example: ") {
            return rest.trim().to_string();
        }
    }
    "linearctl --help".to_string()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn embeds_all_44_command_examples() {
        assert_eq!(EXAMPLES.len(), 44);
        assert!(get_example("comment").unwrap().contains("--body -"));
        assert!(example_hint("file").contains("--desc -"));
    }
}
