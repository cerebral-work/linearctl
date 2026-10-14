//! Token-set Jaccard similarity for duplicate issue detection (`dupcheck`).

use std::cmp::Ordering;
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

const STOPWORDS: &[&str] = &[
    "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "be", "as",
    "at", "by", "it", "its", "from",
];

fn is_stopword(word: &str) -> bool {
    STOPWORDS.contains(&word)
}

/// Tokenize a title into a lowercased, punctuation-stripped, stopword-filtered set of words.
#[must_use]
pub fn tokenize(s: &str) -> BTreeSet<String> {
    let cleaned: String = s
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                ' '
            }
        })
        .collect();

    cleaned
        .split_whitespace()
        .filter(|t| !t.is_empty() && !is_stopword(t))
        .map(str::to_string)
        .collect()
}

/// Compute the Jaccard similarity coefficient (`|A ∩ B| / |A ∪ B|`) in `0.0..=1.0`.
#[must_use]
pub fn jaccard(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count();
    let union = a.len() + b.len() - inter;
    if union == 0 {
        0.0
    } else {
        (inter as f64) / (union as f64)
    }
}

/// Candidate item paired with its Jaccard similarity score.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoredCandidate<T> {
    /// Matched candidate item.
    pub item: T,
    /// Similarity score in `0.0..=1.0`.
    pub score: f64,
}

/// Score candidates against `query`, returning up to `limit` matches with `score >= threshold` sorted best-first.
#[must_use]
pub fn score_candidates<T, F>(
    query: &str,
    candidates: Vec<T>,
    title_of: F,
    threshold: f64,
    limit: usize,
) -> Vec<ScoredCandidate<T>>
where
    F: Fn(&T) -> &str,
{
    let q = tokenize(query);
    let mut scored: Vec<ScoredCandidate<T>> = candidates
        .into_iter()
        .map(|item| {
            let score = jaccard(&q, &tokenize(title_of(&item)));
            ScoredCandidate { item, score }
        })
        .filter(|c| c.score >= threshold)
        .collect();

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
    scored.truncate(limit);
    scored
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn jaccard_strips_stopwords_and_ranks_matches() {
        let a = tokenize("Fix the timeout in the webhook worker");
        let b = tokenize("Webhook worker timeout fix");
        assert!((jaccard(&a, &b) - 1.0).abs() < f64::EPSILON);

        let candidates = vec!["Fix timeout", "Unrelated issue"];
        let matches = score_candidates("Fix timeout", candidates, |s| s, 0.85, 5);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].item, "Fix timeout");
    }
}
