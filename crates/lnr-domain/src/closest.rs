//! Levenshtein distance and closest-name / command suggestion helpers.

use std::collections::BTreeSet;

/// Compute the Levenshtein edit distance between two strings (by Unicode scalar value).
#[must_use]
pub fn levenshtein_distance(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b_chars.len()).collect();

    for (i, &ac) in a_chars.iter().enumerate() {
        let mut next = Vec::with_capacity(b_chars.len() + 1);
        next.push(i + 1);
        for (j, &bc) in b_chars.iter().enumerate() {
            let cost = usize::from(ac != bc);
            let deletion = row
                .get(j + 1)
                .copied()
                .unwrap_or(usize::MAX)
                .saturating_add(1);
            let insertion = next.get(j).copied().unwrap_or(usize::MAX).saturating_add(1);
            let substitution = row
                .get(j)
                .copied()
                .unwrap_or(usize::MAX)
                .saturating_add(cost);
            next.push(deletion.min(insertion).min(substitution));
        }
        row = next;
    }

    row.get(b_chars.len()).copied().unwrap_or(0)
}

/// Return up to 3 closest candidate names to the requested strings, ordered by distance then name.
#[must_use]
pub fn closest_names<S1: AsRef<str>, S2: AsRef<str>>(
    requested: &[S1],
    available: &[S2],
) -> Vec<String> {
    let unique: BTreeSet<&str> = available.iter().map(AsRef::as_ref).collect();
    let mut scored: Vec<(usize, &str)> = unique
        .into_iter()
        .map(|name| {
            let name_lower = name.to_lowercase();
            let score = requested
                .iter()
                .map(|r| levenshtein_distance(&r.as_ref().trim().to_lowercase(), &name_lower))
                .min()
                .unwrap_or(usize::MAX);
            (score, name)
        })
        .collect();

    scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
    scored
        .into_iter()
        .take(3)
        .map(|(_, name)| name.to_string())
        .collect()
}

/// Suggest a command only when the edit distance is close enough to be a plausible typo.
#[must_use]
pub fn closest_command<S: AsRef<str>>(requested: &str, available: &[S]) -> Option<String> {
    let req_slice = [requested];
    let candidate = closest_names(&req_slice, available).into_iter().next()?;
    let dist = levenshtein_distance(requested, &candidate);
    let min_len = requested.chars().count().min(candidate.chars().count());
    let threshold = ((min_len * 2) / 5).max(1);
    (dist <= threshold).then_some(candidate)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn suggests_plausible_command_typos_only() {
        let cmds = ["comment", "ratelimit", "project", "milestone", "whoami"];
        assert_eq!(
            closest_command("commnt", &cmds),
            Some("comment".to_string())
        );
        assert_eq!(
            closest_command("ratelimitt", &cmds),
            Some("ratelimit".to_string())
        );
        assert_eq!(closest_command("nosuchcmd", &cmds), None);
        assert_eq!(closest_command("bogus", &cmds), None);
    }

    #[test]
    fn closest_names_returns_top_three_sorted() {
        let avail = ["feature", "skill", "skills-ui", "skies", "unrelated"];
        let top = closest_names(&["skills"], &avail);
        assert_eq!(top, vec!["skill", "skies", "skills-ui"]);
    }
}
