//! Deterministic second-brain relationship & cross-reference edge extraction
//! (`wikilink@2`, `mdlink@2`, `pathcite@1`, `cratecite@1` from `xerj-autoindex`).
//!
//! Extracts versioned, attributable graph edges from issue/spec prose and resolves
//! them against a repository [`CorpusIndex`] without regexes or external hash crates.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::crypto::sha256_hex;

/// Edge-schema version stamped into every emitted edge (`schema_version`).
pub const EDGE_SCHEMA_VERSION: u32 = 1;

/// Reserved `_id` of the per-brain meta document.
pub const BRAIN_META_ID: &str = "__xerj-brain-meta";

/// Locator of the per-file card node.
pub const FILE_CARD_LOCATOR: &str = "file";

/// Compute a deterministic 32-character lowercase hex `edge_id` over
/// `("xg1\0", src, "\0", edge_type, "\0", dst, "\0", valid_at_ms)`.
#[must_use]
pub fn edge_id(src: &str, edge_type: &str, dst: &str, valid_at_ms: i64) -> String {
    let mut input = Vec::with_capacity(16 + src.len() + edge_type.len() + dst.len());
    input.extend_from_slice(b"xg1\x00");
    input.extend_from_slice(src.as_bytes());
    input.push(0);
    input.extend_from_slice(edge_type.as_bytes());
    input.push(0);
    input.extend_from_slice(dst.as_bytes());
    input.push(0);
    input.extend_from_slice(valid_at_ms.to_string().as_bytes());
    let full = sha256_hex(&input);
    full[..32].to_string()
}

/// Edges index name for a brain (`SECOND_BRAIN_SPEC` section 1).
#[must_use]
pub fn edges_index_name(brain: &str) -> String {
    format!(".xerj-memory-{brain}-edges")
}

/// Validate a second-brain namespace identifier.
///
/// # Errors
///
/// Returns a human-readable error reason if `brain` violates syntax rules.
pub fn validate_brain(brain: &str) -> Result<(), String> {
    if brain.is_empty() {
        return Err("brain name must not be empty".into());
    }
    if brain.len() > 200 {
        return Err("brain name too long (max 200 chars)".into());
    }
    let Some(first) = brain.chars().next() else {
        return Err("brain name must not be empty".into());
    };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return Err("brain name must start with a lowercase letter or digit".into());
    }
    for c in brain.chars() {
        let ok = c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-' | '.');
        if !ok {
            return Err(format!(
                "brain name contains illegal character '{c}' (allowed: a-z 0-9 _ - .)"
            ));
        }
    }
    if brain.contains("..") {
        return Err("brain name must not contain '..'".into());
    }
    if brain.ends_with("-edges") {
        return Err("namespace suffix '-edges' is reserved for graph edge indices".into());
    }
    Ok(())
}

/// Corpus-wide resolution table mapping repository relative paths to file cards, stems,
/// filenames, and crate directories.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CorpusIndex {
    /// Root-relative path with forward slashes -> [`CorpusFile`].
    pub files: BTreeMap<String, CorpusFile>,
    /// Lowercase file-stem -> sorted relative paths bearing it.
    pub by_stem: BTreeMap<String, Vec<String>>,
    /// Exact filename (final path segment) -> sorted relative paths bearing it.
    pub by_name: BTreeMap<String, Vec<String>>,
    /// Crate directory basename -> sorted relative paths of `Cargo.toml` files inside that directory.
    pub crate_dirs: BTreeMap<String, Vec<String>>,
}

/// Metadata for a single indexed file in a [`CorpusIndex`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CorpusFile {
    /// Root-relative path with forward slashes.
    pub rel: String,
    /// Stable file key.
    pub file_key: String,
    /// Dataset slug.
    pub dataset_slug: String,
    /// File-card node document ID (`{dataset_slug}:{file_key}:file`).
    pub anchor_doc_id: String,
    /// Modification timestamp in epoch milliseconds.
    pub mtime_ms: i64,
    /// Parent directory relative path (`""` for root).
    pub dir: String,
    /// Sniffed format family (`"txt-prose"`, `"txt-lines"`, `"pdf"`, etc.).
    pub family: String,
    /// Lowercase extension or fallback family label (`"md"`, `"rs"`, `"toml"`).
    pub format: String,
}

/// Build one [`CorpusFile`] with deterministic `anchor_doc_id`, `dir`, and `format`.
#[must_use]
pub fn corpus_file(
    rel: &str,
    file_key: &str,
    dataset_slug: &str,
    family: &str,
    mtime_ms: i64,
) -> CorpusFile {
    CorpusFile {
        rel: rel.to_string(),
        file_key: file_key.to_string(),
        dataset_slug: dataset_slug.to_string(),
        anchor_doc_id: format!("{dataset_slug}:{file_key}:{FILE_CARD_LOCATOR}"),
        mtime_ms,
        dir: rel
            .rsplit_once('/')
            .map(|(d, _)| d.to_string())
            .unwrap_or_default(),
        family: family.to_string(),
        format: format_of(rel, family),
    }
}

fn format_of(rel: &str, family: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rsplit_once('.') {
        Some((stem, ext))
            if !stem.is_empty()
                && !ext.is_empty()
                && ext.len() <= 12
                && ext.bytes().all(|b| b.is_ascii_alphanumeric()) =>
        {
            ext.to_ascii_lowercase()
        }
        _ => family.to_string(),
    }
}

fn stem_of(rel: &str) -> &str {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem,
        _ => name,
    }
}

fn rel_without_ext(rel: &str) -> String {
    let (dir, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let stem = match name.rsplit_once('.') {
        Some((s, _)) if !s.is_empty() => s,
        _ => name,
    };
    if dir.is_empty() {
        stem.to_string()
    } else {
        format!("{dir}/{stem}")
    }
}

impl CorpusIndex {
    /// Build a [`CorpusIndex`] from a list of [`CorpusFile`] entries.
    #[must_use]
    pub fn build(files: Vec<CorpusFile>) -> Self {
        let mut map: BTreeMap<String, CorpusFile> = BTreeMap::new();
        let mut by_stem: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut by_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut crate_dirs: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for f in files {
            by_stem
                .entry(stem_of(&f.rel).to_ascii_lowercase())
                .or_default()
                .push(f.rel.clone());
            let name = f.rel.rsplit('/').next().unwrap_or(&f.rel);
            by_name
                .entry(name.to_string())
                .or_default()
                .push(f.rel.clone());
            if let Some(dir) = f.rel.strip_suffix("/Cargo.toml") {
                let dir_name = dir.rsplit('/').next().unwrap_or(dir);
                if !dir_name.is_empty() {
                    crate_dirs
                        .entry(dir_name.to_string())
                        .or_default()
                        .push(f.rel.clone());
                }
            }
            map.insert(f.rel.clone(), f);
        }
        for rels in by_stem.values_mut() {
            rels.sort();
            rels.dedup();
        }
        for rels in by_name.values_mut() {
            rels.sort();
            rels.dedup();
        }
        for rels in crate_dirs.values_mut() {
            rels.sort();
            rels.dedup();
        }
        Self {
            files: map,
            by_stem,
            by_name,
            crate_dirs,
        }
    }
}

/// One detected edge before envelope assembly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EdgeDraft {
    /// Source node document ID.
    pub src: String,
    /// Target file's `anchor_doc_id`.
    pub dst: String,
    /// Edge type (`"wikilink"`, `"mdlink"`, `"pathcite"`, `"cratecite"`).
    pub edge_type: String,
    /// Edge weight in `0.0..=1.0`.
    pub weight: f32,
    /// Detector confidence in `0.0..=1.0`.
    pub confidence: f32,
    /// Modification timestamp (`mtime_ms`) of `src_file`.
    pub valid_at_ms: i64,
    /// Relative path of the source file that taught this edge.
    pub src_file: String,
    /// Trimmed line quote (`<= 240` chars) containing the link.
    pub quote: String,
    /// Byte offset in section text.
    pub offset: u64,
    /// Source file format label.
    pub src_format: String,
    /// Destination file format label.
    pub dst_format: String,
}

/// Honesty counters recording unresolved, ambiguous, or capped link candidates.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectorCounters {
    /// Link targets that resolved to no corpus file (dangling).
    pub unresolved: u64,
    /// Link targets with `> 1` candidate; lexicographically smallest relative path won.
    pub ambiguous: u64,
    /// Candidate edges dropped by a density cap.
    pub capped: u64,
}

impl DetectorCounters {
    /// Merge another [`DetectorCounters`] into `self`.
    pub fn add(&mut self, other: Self) {
        self.unresolved += other.unresolved;
        self.ambiguous += other.ambiguous;
        self.capped += other.capped;
    }
}

/// Return the versioned detector tag for a given `edge_type`.
#[must_use]
pub fn detector_tag_for(edge_type: &str) -> &'static str {
    match edge_type {
        "wikilink" => "wikilink@2",
        "mdlink" => "mdlink@2",
        "pathcite" => "pathcite@1",
        "cratecite" => "cratecite@1",
        _ => "unknown@0",
    }
}

fn line_at(text: &str, offset: usize) -> String {
    let offset = offset.min(text.len());
    let start = text[..offset].rfind('\n').map_or(0, |i| i + 1);
    let end = text[offset..].find('\n').map_or(text.len(), |i| offset + i);
    let t = text[start..end].trim();
    if t.chars().count() <= 240 {
        t.to_string()
    } else {
        t.chars().take(240).collect()
    }
}

enum LinkTarget<'a> {
    External,
    Empty,
    Miss,
    Hit(&'a CorpusFile),
}

fn has_scheme(url: &str) -> bool {
    match (url.find(':'), url.find('/')) {
        (Some(c), Some(s)) => c < s,
        (Some(_), None) => true,
        (None, _) => false,
    }
}

fn normalize_rel(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn resolve_local<'a>(corpus: &'a CorpusIndex, containing_dir: &str, url: &str) -> LinkTarget<'a> {
    let url = url.trim();
    if url.is_empty() {
        return LinkTarget::Empty;
    }
    if url.starts_with("//") || has_scheme(url) {
        return LinkTarget::External;
    }
    let path = url.split(['#', '?']).next().unwrap_or("");
    if path.is_empty() {
        return LinkTarget::Empty;
    }
    let candidates: [Option<String>; 2] = if let Some(site_abs) = path.strip_prefix('/') {
        [normalize_rel(site_abs), None]
    } else {
        let joined = if containing_dir.is_empty() {
            path.to_string()
        } else {
            format!("{containing_dir}/{path}")
        };
        [normalize_rel(&joined), normalize_rel(path)]
    };
    for cand in candidates.into_iter().flatten() {
        if let Some(f) = corpus.files.get(&cand) {
            return LinkTarget::Hit(f);
        }
    }
    LinkTarget::Miss
}

// ============================================================================
// 1. Wikilink Detector (wikilink@2)
// ============================================================================

/// Detect `[[Target]]` and `[[Target|alias]]` wikilinks in `text`.
#[must_use]
pub fn detect_wikilinks(
    corpus: &CorpusIndex,
    file: &CorpusFile,
    section_doc_id: &str,
    text: &str,
) -> (Vec<EdgeDraft>, DetectorCounters) {
    const MAX_TARGET_LEN: usize = 512;
    let mut out = Vec::new();
    let mut counters = DetectorCounters::default();
    let mut i = 0_usize;

    while let Some(open) = text[i..].find("[[") {
        let open = i + open;
        let Some(close) = text[open + 2..].find("]]") else {
            break;
        };
        let close = open + 2 + close;
        i = close + 2;
        let inner = &text[open + 2..close];
        if inner.len() > MAX_TARGET_LEN || inner.contains("[[") {
            continue;
        }
        let target = inner.split('|').next().unwrap_or("").trim();
        if target.is_empty() {
            continue;
        }

        let resolved: Option<(&CorpusFile, bool)> = if let Some(f) = corpus.files.get(target) {
            Some((f, false))
        } else {
            let mut without_ext = corpus
                .files
                .iter()
                .filter(|(rel, _)| rel_without_ext(rel) == target);
            if let Some((_, first)) = without_ext.next() {
                Some((first, without_ext.next().is_some()))
            } else {
                match corpus.by_stem.get(&target.to_ascii_lowercase()) {
                    Some(rels) if rels.len() == 1 => Some((&corpus.files[&rels[0]], false)),
                    Some(rels) if !rels.is_empty() => Some((&corpus.files[&rels[0]], true)),
                    _ => None,
                }
            }
        };

        let Some((target_file, is_ambiguous)) = resolved else {
            counters.unresolved += 1;
            continue;
        };
        if is_ambiguous {
            counters.ambiguous += 1;
        }

        out.push(EdgeDraft {
            src: section_doc_id.to_string(),
            dst: target_file.anchor_doc_id.clone(),
            edge_type: "wikilink".to_string(),
            weight: 1.0,
            confidence: 0.95,
            valid_at_ms: file.mtime_ms,
            src_file: file.rel.clone(),
            quote: line_at(text, open),
            offset: open as u64,
            src_format: file.format.clone(),
            dst_format: target_file.format.clone(),
        });
    }

    (out, counters)
}

// ============================================================================
// 2. Markdown Link Detector (mdlink@2)
// ============================================================================

/// Detect `[label](relative/path.md)` markdown links in `text`.
#[must_use]
pub fn detect_mdlinks(
    corpus: &CorpusIndex,
    file: &CorpusFile,
    section_doc_id: &str,
    text: &str,
) -> (Vec<EdgeDraft>, DetectorCounters) {
    let mut out = Vec::new();
    let mut counters = DetectorCounters::default();
    let bytes = text.as_bytes();
    let mut i = 0_usize;

    while i < bytes.len() {
        let Some(open) = text[i..].find('[') else {
            break;
        };
        let open = i + open;
        let Some(close) = text[open + 1..].find(']') else {
            break;
        };
        let close = open + 1 + close;
        if bytes.get(close + 1) != Some(&b'(') {
            i = open + 1;
            continue;
        }
        let Some(paren) = text[close + 2..].find(')') else {
            break;
        };
        let paren = close + 2 + paren;
        let raw = text[close + 2..paren].trim();
        let url = raw.split_whitespace().next().unwrap_or("");

        match resolve_local(corpus, &file.dir, url) {
            LinkTarget::Hit(target) => out.push(EdgeDraft {
                src: section_doc_id.to_string(),
                dst: target.anchor_doc_id.clone(),
                edge_type: "mdlink".to_string(),
                weight: 0.9,
                confidence: 0.9,
                valid_at_ms: file.mtime_ms,
                src_file: file.rel.clone(),
                quote: line_at(text, open),
                offset: open as u64,
                src_format: file.format.clone(),
                dst_format: target.format.clone(),
            }),
            LinkTarget::External | LinkTarget::Empty => {}
            LinkTarget::Miss => {
                counters.unresolved += 1;
            }
        }
        i = paren + 1;
    }

    (out, counters)
}

// ============================================================================
// 3. Path Citation Detector (pathcite@1, pure byte scanner)
// ============================================================================

fn is_path_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'/' | b'-')
}

fn is_ext_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Scan maximal `[A-Za-z0-9_./-]+` tokens that end in `.<alnum_or_underscore>+`.
fn scan_path_tokens(text: &str, mut visit: impl FnMut(usize, &str)) {
    let bytes = text.as_bytes();
    let n = bytes.len();
    let mut i = 0_usize;

    while i < n {
        if !is_path_token_byte(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < n && is_path_token_byte(bytes[i]) {
            i += 1;
        }
        let mut end = i;
        // Trim any trailing '.', '/', '-' so we land on a valid `.ext` suffix if one exists inside the run
        while end > start && !is_ext_byte(bytes[end - 1]) {
            end -= 1;
        }
        if end <= start {
            continue;
        }
        let candidate = &text[start..end];
        if let Some((prefix, ext)) = candidate.rsplit_once('.') {
            if !prefix.is_empty() && !ext.is_empty() && ext.bytes().all(is_ext_byte) {
                visit(start, candidate);
            }
        }
    }
}

/// Detect bare file-path citations (`src/index.rs:42`) in `text`.
#[must_use]
pub fn detect_pathcites(
    corpus: &CorpusIndex,
    file: &CorpusFile,
    section_doc_id: &str,
    text: &str,
) -> (Vec<EdgeDraft>, DetectorCounters) {
    let mut out = Vec::new();
    let mut counters = DetectorCounters::default();

    scan_path_tokens(text, |match_start, raw_token| {
        let mut token = raw_token;
        loop {
            let trimmed = token
                .trim_start_matches('/')
                .trim_start_matches("./")
                .trim_start_matches("../");
            if trimmed.len() == token.len() {
                break;
            }
            token = trimmed;
        }
        if token.is_empty() {
            return;
        }
        let offset = (match_start + (raw_token.len() - token.len())) as u64;

        let target: &CorpusFile = if let Some(f) = corpus.files.get(token) {
            f
        } else {
            let segments = token.split('/').filter(|s| !s.is_empty()).count();
            let name = token.rsplit('/').next().unwrap_or(token);
            let candidates = corpus.by_name.get(name);
            if segments >= 2 {
                let suffix = format!("/{token}");
                let mut hits = candidates
                    .into_iter()
                    .flatten()
                    .filter(|rel| rel.ends_with(&suffix));
                match (hits.next(), hits.next()) {
                    (Some(rel), None) => &corpus.files[rel],
                    (Some(rel), Some(_)) => {
                        counters.ambiguous += 1;
                        &corpus.files[rel]
                    }
                    (None, _) => {
                        counters.unresolved += 1;
                        return;
                    }
                }
            } else {
                if candidates.is_some_and(|rels| !rels.is_empty()) {
                    counters.ambiguous += 1;
                }
                return;
            }
        };

        if target.rel == file.rel {
            return;
        }

        out.push(EdgeDraft {
            src: section_doc_id.to_string(),
            dst: target.anchor_doc_id.clone(),
            edge_type: "pathcite".to_string(),
            weight: 0.6,
            confidence: 0.7,
            valid_at_ms: file.mtime_ms,
            src_file: file.rel.clone(),
            quote: line_at(text, match_start),
            offset,
            src_format: file.format.clone(),
            dst_format: target.format.clone(),
        });
    });

    (out, counters)
}

// ============================================================================
// 4. Crate Citation Detector (cratecite@1)
// ============================================================================

fn is_crate_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/')
}

fn boundary_after(rest: &str) -> bool {
    let mut it = rest.chars();
    match it.next() {
        None => true,
        Some('.') => !it
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'),
        Some(c) => !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/')),
    }
}

/// Detect crate directory citations (`lnr-domain`, `xerj-fts`) in `text`.
#[must_use]
pub fn detect_cratecites(
    corpus: &CorpusIndex,
    file: &CorpusFile,
    section_doc_id: &str,
    text: &str,
) -> (Vec<EdgeDraft>, DetectorCounters) {
    let mut out = Vec::new();
    let mut counters = DetectorCounters::default();

    for (name, rels) in &corpus.crate_dirs {
        if !(name.contains('-') || name.contains('_')) {
            continue;
        }
        let mut from = 0_usize;
        while let Some(found) = text[from..].find(name.as_str()) {
            let pos = from + found;
            from = pos + name.len();
            let before_ok = text[..pos]
                .chars()
                .next_back()
                .is_none_or(|c| !is_crate_word(c));
            let after_ok = boundary_after(&text[pos + name.len()..]);
            if !before_ok || !after_ok {
                continue;
            }
            if rels.len() > 1 {
                counters.ambiguous += 1;
            }
            let target = &corpus.files[&rels[0]];
            if target.rel == file.rel {
                continue;
            }
            out.push(EdgeDraft {
                src: section_doc_id.to_string(),
                dst: target.anchor_doc_id.clone(),
                edge_type: "cratecite".to_string(),
                weight: 0.5,
                confidence: 0.6,
                valid_at_ms: file.mtime_ms,
                src_file: file.rel.clone(),
                quote: line_at(text, pos),
                offset: pos as u64,
                src_format: file.format.clone(),
                dst_format: target.format.clone(),
            });
        }
    }

    (out, counters)
}

/// Run all four deterministic text detectors (`wikilink@2`, `mdlink@2`, `pathcite@1`, `cratecite@1`)
/// over `text` and return the combined [`EdgeDraft`] list and [`DetectorCounters`].
#[must_use]
pub fn detect_all_edges(
    corpus: &CorpusIndex,
    file: &CorpusFile,
    section_doc_id: &str,
    text: &str,
) -> (Vec<EdgeDraft>, DetectorCounters) {
    let mut drafts = Vec::new();
    let mut counters = DetectorCounters::default();

    let (w, cw) = detect_wikilinks(corpus, file, section_doc_id, text);
    drafts.extend(w);
    counters.add(cw);

    let (m, cm) = detect_mdlinks(corpus, file, section_doc_id, text);
    drafts.extend(m);
    counters.add(cm);

    let (p, cp) = detect_pathcites(corpus, file, section_doc_id, text);
    drafts.extend(p);
    counters.add(cp);

    let (k, ck) = detect_cratecites(corpus, file, section_doc_id, text);
    drafts.extend(k);
    counters.add(ck);

    (drafts, counters)
}

/// Assemble an [`EdgeDraft`] into its canonical JSON document with `edge_id` and `detector`.
#[must_use]
pub fn assemble_edge_json(draft: &EdgeDraft, created_at_ms: i64) -> Value {
    let id = edge_id(&draft.src, &draft.edge_type, &draft.dst, draft.valid_at_ms);
    let tag = detector_tag_for(&draft.edge_type);
    json!({
        "edge_id": id,
        "src": draft.src,
        "dst": draft.dst,
        "type": draft.edge_type,
        "weight": draft.weight,
        "valid_at": draft.valid_at_ms,
        "created_at": created_at_ms,
        "detector": tag,
        "confidence": draft.confidence,
        "schema_version": EDGE_SCHEMA_VERSION,
        "src_file": draft.src_file,
        "src_format": draft.src_format,
        "dst_format": draft.dst_format,
        "evidence": {
            "quote": draft.quote,
            "source": draft.src_file,
            "offset": draft.offset,
        }
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn sample_corpus() -> CorpusIndex {
        CorpusIndex::build(vec![
            corpus_file("docs/guide.md", "k0", "lnr", "txt-prose", 1000),
            corpus_file("specs/0003-borrow.md", "k1", "lnr", "txt-prose", 1000),
            corpus_file(
                "crates/lnr-domain/Cargo.toml",
                "k2",
                "lnr",
                "txt-lines",
                1000,
            ),
            corpus_file(
                "crates/lnr-domain/src/bm25.rs",
                "k3",
                "lnr",
                "txt-lines",
                1000,
            ),
        ])
    }

    #[test]
    fn detects_wikilink_mdlink_pathcite_and_cratecite() {
        let corpus = sample_corpus();
        let file = &corpus.files["docs/guide.md"];
        let text = "See [[0003-borrow]] and [spec](../specs/0003-borrow.md). \
                    Implemented in lnr-domain/src/bm25.rs:42 inside crate lnr-domain.";

        let (edges, counters) = detect_all_edges(&corpus, file, "sec0", text);
        assert!(edges.iter().any(|e| e.edge_type == "wikilink"));
        assert!(edges.iter().any(|e| e.edge_type == "mdlink"));
        assert!(edges.iter().any(|e| e.edge_type == "pathcite"));
        assert!(edges.iter().any(|e| e.edge_type == "cratecite"));
        assert_eq!(counters.unresolved, 0);
    }

    #[test]
    fn brain_validation_enforces_rules() {
        assert!(validate_brain("lnr-kb").is_ok());
        assert!(validate_brain("kb-edges").is_err());
        assert!(validate_brain("../bad").is_err());
    }
}
