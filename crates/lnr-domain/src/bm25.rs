//! BM25 relevance scoring, identifier-aware sub-word analysis, and multi-field
//! Linear issue indexing borrowed from `xerj` (`xerj-fts/src/bm25.rs` and `analyzer.rs`).
//!
//! ## Formula
//!
//! ```text
//! score(q, d) = sum_t [ IDF(t) * TF(t, d) ]
//! IDF(t) = ln(1 + (N - n_t + 0.5) / (n_t + 0.5))
//! TF(t, d) = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgdl)))
//! ```

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// Default term-frequency saturation constant (`k1 = 1.2`, matching Lucene/Elasticsearch).
pub const DEFAULT_K1: f32 = 1.2;

/// Default length normalization constant (`b = 0.75`, matching Lucene/Elasticsearch).
pub const DEFAULT_B: f32 = 0.75;

/// Stateless BM25 scorer seeded with per-field collection statistics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bm25Scorer {
    /// Term frequency saturation (`k1`).
    pub k1: f32,
    /// Length normalization factor (`b`).
    pub b: f32,
    /// Average field length across all documents in the collection.
    pub avg_dl: f32,
    /// Total number of documents in the collection (`N`).
    pub total_docs: u64,
}

impl Bm25Scorer {
    /// Construct a scorer with Elasticsearch-compatible defaults (`k1 = 1.2`, `b = 0.75`).
    #[must_use]
    pub fn new(avg_dl: f32, total_docs: u64) -> Self {
        Self {
            k1: DEFAULT_K1,
            b: DEFAULT_B,
            avg_dl,
            total_docs,
        }
    }

    /// Construct a scorer with custom `k1` and `b` parameters.
    #[must_use]
    pub fn with_params(k1: f32, b: f32, avg_dl: f32, total_docs: u64) -> Self {
        Self {
            k1,
            b,
            avg_dl,
            total_docs,
        }
    }

    /// Compute Lucene smoothed inverse document frequency (`IDF = ln(1 + (N - n + 0.5) / (n + 0.5))`).
    #[must_use]
    #[inline]
    pub fn idf(&self, doc_freq: u64) -> f32 {
        let n = self.total_docs as f32;
        let df = doc_freq as f32;
        ((1.0 + (n - df + 0.5) / (df + 0.5)).ln()).max(0.0)
    }

    /// Compute the normalized term frequency factor (`TF_norm`).
    #[must_use]
    #[inline]
    pub fn tf_norm(&self, term_freq: u32, doc_length: u32) -> f32 {
        let tf = term_freq as f32;
        let dl = doc_length as f32;
        let avg = self.avg_dl.max(1.0);
        let norm = self.k1 * (1.0 - self.b + self.b * (dl / avg));
        (tf * (self.k1 + 1.0)) / (tf + norm)
    }

    /// Score a single `(term, document)` pair.
    #[must_use]
    #[inline]
    pub fn score_term(&self, doc_freq: u64, term_freq: u32, doc_length: u32) -> f32 {
        self.idf(doc_freq) * self.tf_norm(term_freq, doc_length)
    }

    /// Score a single `(term, document)` pair with an `_explain`-style breakdown.
    #[must_use]
    pub fn score_term_explain(
        &self,
        term: &str,
        doc_freq: u64,
        term_freq: u32,
        doc_length: u32,
    ) -> ScoreBreakdown {
        let idf = self.idf(doc_freq);
        let tf = self.tf_norm(term_freq, doc_length);
        let score = idf * tf;

        ScoreBreakdown {
            score,
            term: term.to_owned(),
            idf,
            tf_norm: tf,
            term_freq,
            doc_freq,
            doc_length,
            avg_dl: self.avg_dl,
            total_docs: self.total_docs,
            k1: self.k1,
            b: self.b,
        }
    }
}

/// Detailed breakdown of how a single-term BM25 score was computed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoreBreakdown {
    /// Final BM25 score (`idf * tf_norm`).
    pub score: f32,
    /// Query term that generated this contribution.
    pub term: String,
    /// Inverse document frequency component.
    pub idf: f32,
    /// Normalized term frequency component.
    pub tf_norm: f32,
    /// Raw term frequency in the document.
    pub term_freq: u32,
    /// Number of documents containing this term.
    pub doc_freq: u64,
    /// Length of the field in the document (in tokens).
    pub doc_length: u32,
    /// Average field length across the collection.
    pub avg_dl: f32,
    /// Total documents in the collection.
    pub total_docs: u64,
    /// Saturation parameter `k1`.
    pub k1: f32,
    /// Length normalization parameter `b`.
    pub b: f32,
}

impl ScoreBreakdown {
    /// Render a human-readable explanation matching `xerj-fts` `_explain`.
    #[must_use]
    pub fn describe(&self) -> String {
        format!(
            "score({term}) = {score:.6} = idf({idf:.6}) * tf_norm({tf_norm:.6})\n\
             idf = ln(1 + ({n_docs} - {df} + 0.5) / ({df} + 0.5))\n\
             tf_norm = ({tf} * ({k1} + 1)) / ({tf} + {k1} * (1 - {b} + {b} * ({dl} / {avgdl})))",
            term = self.term,
            score = self.score,
            idf = self.idf,
            tf_norm = self.tf_norm,
            n_docs = self.total_docs,
            df = self.doc_freq,
            tf = self.term_freq,
            k1 = self.k1,
            b = self.b,
            dl = self.doc_length,
            avgdl = self.avg_dl,
        )
    }
}

/// Aggregated BM25 score explanation for a multi-term query.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryExplanation {
    /// Sum of all per-term scores.
    pub total_score: f32,
    /// Per-term breakdowns.
    pub term_breakdowns: Vec<ScoreBreakdown>,
}

impl QueryExplanation {
    /// Construct a new [`QueryExplanation`] from per-term breakdowns.
    #[must_use]
    pub fn new(breakdowns: Vec<ScoreBreakdown>) -> Self {
        let total_score = breakdowns.iter().map(|b| b.score).sum();
        Self {
            total_score,
            term_breakdowns: breakdowns,
        }
    }
}

/// Aggregated field-level statistics needed to construct a [`Bm25Scorer`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldStats {
    /// Total number of documents that have this field.
    pub total_docs: u64,
    /// Sum of all field lengths (in tokens) across all documents.
    pub total_field_length: u64,
}

impl FieldStats {
    /// Return the average field length (`total_field_length / total_docs`), or `0.0` if empty.
    #[must_use]
    pub fn avg_field_length(&self) -> f32 {
        if self.total_docs == 0 {
            return 0.0;
        }
        self.total_field_length as f32 / self.total_docs as f32
    }

    /// Build a default [`Bm25Scorer`] from these statistics.
    #[must_use]
    pub fn to_scorer(&self) -> Bm25Scorer {
        Bm25Scorer::new(self.avg_field_length(), self.total_docs)
    }

    /// Build a [`Bm25Scorer`] with custom `k1` and `b` parameters.
    #[must_use]
    pub fn to_scorer_with_params(&self, k1: f32, b: f32) -> Bm25Scorer {
        Bm25Scorer::with_params(k1, b, self.avg_field_length(), self.total_docs)
    }
}

impl std::ops::AddAssign<&FieldStats> for FieldStats {
    fn add_assign(&mut self, rhs: &FieldStats) {
        self.total_docs += rhs.total_docs;
        self.total_field_length += rhs.total_field_length;
    }
}

/// Index-wide BM25 collection statistics folded across segments or shards.
#[derive(Debug, Clone, Default)]
pub struct CollectionStats {
    fields: HashMap<String, FieldStats>,
    doc_freq: HashMap<(String, String), u64>,
}

impl CollectionStats {
    /// Create an empty [`CollectionStats`].
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one arm's [`FieldStats`] for `field` into the union.
    pub fn add_field(&mut self, field: &str, stats: &FieldStats) {
        if stats.total_docs == 0 && stats.total_field_length == 0 {
            return;
        }
        match self.fields.get_mut(field) {
            Some(acc) => *acc += stats,
            None => {
                self.fields.insert(field.to_owned(), stats.clone());
            }
        }
    }

    /// Fold one arm's `doc_freq` for `(field, term)` into the union.
    pub fn add_doc_freq(&mut self, field: &str, term: &str, df: u64) {
        if df == 0 {
            return;
        }
        *self
            .doc_freq
            .entry((field.to_owned(), term.to_owned()))
            .or_insert(0) += df;
    }

    /// Return the union [`FieldStats`] for `field`, if present.
    #[must_use]
    pub fn field(&self, field: &str) -> Option<&FieldStats> {
        self.fields.get(field)
    }

    /// Return a [`Bm25Scorer`] seeded with the index-wide `avgdl` and `N` for `field`.
    #[must_use]
    pub fn scorer(&self, field: &str) -> Option<Bm25Scorer> {
        self.fields
            .get(field)
            .filter(|s| s.total_docs > 0)
            .map(FieldStats::to_scorer)
    }

    /// Return the index-wide `doc_freq` for `(field, term)`.
    #[must_use]
    pub fn df(&self, field: &str, term: &str) -> Option<u64> {
        self.doc_freq
            .get(&(field.to_owned(), term.to_owned()))
            .copied()
    }

    /// Return `true` when no arm contributed any statistics.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.fields.is_empty() && self.doc_freq.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Analyzer primitives borrowed from `xerj-fts/src/analyzer.rs`
// ---------------------------------------------------------------------------

/// Split a single alphanumeric run on camelCase, acronym, and letter/digit boundaries.
#[must_use]
pub fn split_identifier_run(run: &str) -> Vec<String> {
    let chars: Vec<char> = run.chars().collect();
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    for i in 0..chars.len() {
        let c = chars[i];
        if !cur.is_empty() {
            let prev = chars[i - 1];
            let lower_to_upper = prev.is_lowercase() && c.is_uppercase();
            let letter_to_digit = prev.is_alphabetic() && c.is_ascii_digit();
            let digit_to_letter = prev.is_ascii_digit() && c.is_alphabetic();
            let acronym_tail = prev.is_uppercase()
                && c.is_uppercase()
                && i + 1 < chars.len()
                && chars[i + 1].is_lowercase();
            if lower_to_upper || letter_to_digit || digit_to_letter || acronym_tail {
                words.push(std::mem::take(&mut cur));
            }
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
}

/// Produce the ordered, deduplicated set of sub-words for one identifier token (`WordDelimiterFilter`).
#[must_use]
pub fn word_delimiter_subwords(token: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for run in token.split(|c: char| !c.is_alphanumeric()) {
        if run.is_empty() {
            continue;
        }
        if run != token && seen.insert(run.to_string()) {
            out.push(run.to_string());
        }
        let parts = split_identifier_run(run);
        if parts.len() > 1 {
            for w in parts {
                if w != token && seen.insert(w.clone()) {
                    out.push(w);
                }
            }
        }
    }
    out
}

/// Fold a string to ASCII (`AsciiFoldingFilter` from `xerj-fts`), stripping combining marks and mapping Latin-1 / Extended-A letters.
#[must_use]
pub fn fold_to_ascii(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let cp = c as u32;
        if (0x0300..=0x036F).contains(&cp) {
            continue;
        }
        if (0x0100..=0x017F).contains(&cp) {
            match cp {
                0x0100..=0x0105 => out.push('a'),
                0x0106..=0x010D => out.push('c'),
                0x010E..=0x0111 => out.push('d'),
                0x0112..=0x011B => out.push('e'),
                0x011C..=0x0123 => out.push('g'),
                0x0124..=0x0127 => out.push('h'),
                0x0128..=0x0131 => out.push('i'),
                0x0132..=0x0133 => out.push_str("ij"),
                0x0134..=0x0135 => out.push('j'),
                0x0136..=0x0138 => out.push('k'),
                0x0139..=0x0142 => out.push('l'),
                0x0143..=0x014B => out.push('n'),
                0x014C..=0x0151 => out.push('o'),
                0x0152..=0x0153 => out.push_str("oe"),
                0x0154..=0x0159 => out.push('r'),
                0x015A..=0x0161 => out.push('s'),
                0x0162..=0x0167 => out.push('t'),
                0x0168..=0x0173 => out.push('u'),
                0x0174..=0x0175 => out.push('w'),
                0x0176..=0x0178 => out.push('y'),
                0x0179..=0x017E => out.push('z'),
                0x017F => out.push('s'),
                _ => out.push(c),
            }
            continue;
        }
        match c {
            'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => {
                out.push('a');
            }
            'Æ' | 'æ' => out.push_str("ae"),
            'Ç' | 'ç' => out.push('c'),
            'Ð' | 'ð' => out.push('d'),
            'È' | 'É' | 'Ê' | 'Ë' | 'è' | 'é' | 'ê' | 'ë' => out.push('e'),
            'Ì' | 'Í' | 'Î' | 'Ï' | 'ì' | 'í' | 'î' | 'ï' => out.push('i'),
            'Ñ' | 'ñ' => out.push('n'),
            'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' | 'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' => {
                out.push('o');
            }
            'ß' => out.push_str("ss"),
            'Þ' | 'þ' => out.push_str("th"),
            'Ù' | 'Ú' | 'Û' | 'Ü' | 'ù' | 'ú' | 'û' | 'ü' => out.push('u'),
            'Ý' | 'ÿ' | 'ý' => out.push('y'),
            other => out.push(other),
        }
    }
    out
}

/// Tokenize text using `WordDelimiterFilter` + `AsciiFoldingFilter` + lowercase normalization.
#[must_use]
pub fn analyze_terms(input: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for raw_token in input.split(|c: char| {
        c.is_whitespace()
            || matches!(
                c,
                ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'' | '`'
            )
    }) {
        let trimmed = raw_token.trim_matches(|c: char| !c.is_alphanumeric());
        if trimmed.is_empty() {
            continue;
        }
        for sub in word_delimiter_subwords(trimmed) {
            let folded = fold_to_ascii(&sub).to_ascii_lowercase();
            if !folded.is_empty() {
                terms.push(folded);
            }
        }
        let whole = fold_to_ascii(trimmed).to_ascii_lowercase();
        if !whole.is_empty() {
            terms.push(whole);
        }
    }
    terms
}

// ---------------------------------------------------------------------------
// Multi-field BM25 Issue Search Index
// ---------------------------------------------------------------------------

/// A Linear issue document indexed for local BM25 search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bm25IssueDoc {
    /// Linear issue UUID or identifier.
    pub id: String,
    /// Human-readable identifier (e.g. `"CER-104"`).
    pub identifier: String,
    /// Issue title.
    pub title: String,
    /// Optional markdown description.
    #[serde(default)]
    pub description: Option<String>,
    /// Workflow state name (e.g. `"In Progress"`).
    #[serde(default)]
    pub state: Option<String>,
}

/// A ranked BM25 search hit over [`Bm25IssueDoc`]s.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bm25SearchHit {
    /// Issue UUID.
    pub id: String,
    /// Issue identifier (e.g. `"CER-104"`).
    pub identifier: String,
    /// Issue title.
    pub title: String,
    /// Workflow state name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// Combined weighted BM25 score (`identifier * 3.0 + title * 2.0 + description * 1.0`).
    pub score: f32,
    /// Per-term score breakdowns.
    pub explanation: QueryExplanation,
}

/// In-memory multi-field BM25 index over Linear issues.
#[derive(Debug, Clone, Default)]
pub struct Bm25IssueIndex {
    docs: Vec<Bm25IssueDoc>,
    doc_terms: Vec<BTreeMap<String, u32>>,
    doc_lengths: Vec<u32>,
    doc_freqs: BTreeMap<String, u64>,
    stats: FieldStats,
}

impl Bm25IssueIndex {
    /// Build a [`Bm25IssueIndex`] from a slice of [`Bm25IssueDoc`]s.
    #[must_use]
    pub fn build(docs: Vec<Bm25IssueDoc>) -> Self {
        let mut doc_terms = Vec::with_capacity(docs.len());
        let mut doc_lengths = Vec::with_capacity(docs.len());
        let mut doc_freqs: BTreeMap<String, u64> = BTreeMap::new();
        let mut total_field_length = 0u64;

        for doc in &docs {
            // Boost identifier (3x) and title (2x) relative to description (1x)
            let mut tf_map: BTreeMap<String, u32> = BTreeMap::new();
            let mut dl = 0u32;

            for term in analyze_terms(&doc.identifier) {
                *tf_map.entry(term).or_insert(0) += 3;
                dl += 3;
            }
            for term in analyze_terms(&doc.title) {
                *tf_map.entry(term).or_insert(0) += 2;
                dl += 2;
            }
            if let Some(desc) = &doc.description {
                for term in analyze_terms(desc) {
                    *tf_map.entry(term).or_insert(0) += 1;
                    dl += 1;
                }
            }

            for term in tf_map.keys() {
                *doc_freqs.entry(term.clone()).or_insert(0) += 1;
            }

            total_field_length += u64::from(dl);
            doc_terms.push(tf_map);
            doc_lengths.push(dl);
        }

        let stats = FieldStats {
            total_docs: docs.len() as u64,
            total_field_length,
        };

        Self {
            docs,
            doc_terms,
            doc_lengths,
            doc_freqs,
            stats,
        }
    }

    /// Search the index with a natural-language or identifier query and return up to `limit` hits.
    #[must_use]
    pub fn search(&self, query: &str, limit: usize) -> Vec<Bm25SearchHit> {
        if self.docs.is_empty() || limit == 0 {
            return Vec::new();
        }
        let mut query_terms = analyze_terms(query);
        query_terms.sort();
        query_terms.dedup();
        if query_terms.is_empty() {
            return Vec::new();
        }

        let scorer = self.stats.to_scorer();
        let mut hits = Vec::new();

        for (idx, doc) in self.docs.iter().enumerate() {
            let tf_map = &self.doc_terms[idx];
            let dl = self.doc_lengths[idx];
            let mut breakdowns = Vec::new();

            for q_term in &query_terms {
                if let Some(&tf) = tf_map.get(q_term) {
                    let df = self.doc_freqs.get(q_term).copied().unwrap_or(1);
                    breakdowns.push(scorer.score_term_explain(q_term, df, tf, dl));
                }
            }

            if !breakdowns.is_empty() {
                let explanation = QueryExplanation::new(breakdowns);
                hits.push(Bm25SearchHit {
                    id: doc.id.clone(),
                    identifier: doc.identifier.clone(),
                    title: doc.title.clone(),
                    state: doc.state.clone(),
                    score: explanation.total_score,
                    explanation,
                });
            }
        }

        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.identifier.cmp(&b.identifier))
        });
        hits.truncate(limit);
        hits
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn idf_and_tf_norm_match_lucene_bm25() {
        let scorer = Bm25Scorer::new(3.67, 3);
        let idf = scorer.idf(3);
        assert!((idf - 0.1335).abs() < 0.001, "idf = {idf}");

        let rare_scorer = Bm25Scorer::new(100.0, 1_000_000);
        let rare_idf = rare_scorer.idf(1);
        assert!(rare_idf > 13.0 && rare_idf < 14.0);
    }

    #[test]
    fn index_wide_stats_demote_lone_memtable_document() {
        let (tf, dl) = (1u32, 87u32);
        let lone = FieldStats {
            total_docs: 1,
            total_field_length: 87,
        };
        let before = lone.to_scorer().score_term(1, tf, dl);
        assert!((before - 0.287_682_12).abs() < 1e-6);

        let union = FieldStats {
            total_docs: 366,
            total_field_length: 417_047,
        };
        let scorer = union.to_scorer();
        let weak = scorer.score_term(366, tf, dl);
        let strong = scorer.score_term(366, 10, 10);
        assert!(strong > weak);
        assert!(before > strong);
    }

    #[test]
    fn word_delimiter_and_ascii_folding_work() {
        let subs = word_delimiter_subwords("getHTTPResponse_v2");
        assert!(subs.contains(&"get".to_string()));
        assert!(subs.contains(&"HTTP".to_string()));
        assert!(subs.contains(&"Response".to_string()));
        assert_eq!(fold_to_ascii("Café naïve Łódź"), "Cafe naive lodz");
    }

    #[test]
    fn bm25_issue_index_ranks_relevant_issues_first() {
        let docs = vec![
            Bm25IssueDoc {
                id: "1".to_string(),
                identifier: "ENG-101".to_string(),
                title: "Fix GraphQL rateLimit retry backoff".to_string(),
                description: Some("Handle HTTP 429 in LinearClient".to_string()),
                state: Some("In Progress".to_string()),
            },
            Bm25IssueDoc {
                id: "2".to_string(),
                identifier: "ENG-102".to_string(),
                title: "Update documentation README".to_string(),
                description: Some("Add install instructions".to_string()),
                state: Some("Todo".to_string()),
            },
        ];
        let index = Bm25IssueIndex::build(docs);
        let hits = index.search("rate limit 429", 5);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].identifier, "ENG-101");
        assert!(hits[0].score > 0.0);
        assert!(hits[0].explanation.term_breakdowns[0]
            .describe()
            .contains("score("));
    }
}
