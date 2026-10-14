//! Token budgets for MCP tool and CLI responses borrowed from `xerj` (`xerj-mcp/src/token_budget.rs`).
//!
//! Enforces a hard `max_tokens` ceiling over JSON and text responses:
//! 1. **Dedup before budgeting**: hits with overlapping `file:line` spans are dropped and counted.
//! 2. **Greedy keep in rank order** until the remaining token budget would be exceeded.
//! 3. **Over-budget items become locator stubs** (`id`, `identifier`, `title`, `_index`, `_id`, `path`, `line`) while they fit.
//! 4. **Hard invariant**: `count_tokens(&out) <= max_tokens` holds across all inputs.

use serde_json::{json, Value};

/// Human-readable description of the tokenizer used for response budgeting.
pub const TOKENIZER_NAME: &str = "XERJ StandardTokenizer (alphanumeric word boundaries)";

/// Short identifier reported in `_token_budget.tokenizer`.
pub const TOKENIZER_ID: &str = "standard-uax29-words";

/// Smallest accepted `max_tokens` floor (`32`).
pub const MIN_MAX_TOKENS: usize = 32;

const NOTE_RESERVE: usize = 32;
const TOKENS_USED_INSERT: usize = 2;
const TRUNCATION_MARKER: &str = "\n[truncated at the max_tokens budget]";

/// Validate and extract the optional `max_tokens` argument from an MCP or CLI JSON payload.
///
/// # Errors
///
/// Returns an error string if `max_tokens` is present but not an integer `>= MIN_MAX_TOKENS`.
pub fn opt_max_tokens(args: &Value) -> Result<Option<usize>, String> {
    match args.get("max_tokens") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_u64() {
            Some(n) => {
                let val = usize::try_from(n).unwrap_or(usize::MAX);
                if val >= MIN_MAX_TOKENS {
                    Ok(Some(val))
                } else {
                    Err(format!(
                        "`max_tokens` must be an integer >= {MIN_MAX_TOKENS} (tokens are counted as \
                         word boundaries by {TOKENIZER_NAME})"
                    ))
                }
            }
            None => Err(format!(
                "`max_tokens` must be an integer >= {MIN_MAX_TOKENS} (tokens are counted as \
                 word boundaries by {TOKENIZER_NAME})"
            )),
        },
    }
}

/// Iterate word spans `(byte_start, byte_end)` in `text` where words are contiguous runs of
/// alphanumeric or underscore/apostrophe characters inside words (matching UAX #29 word-boundary splitting).
fn word_byte_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut current_start: Option<usize> = None;

    for (idx, ch) in text.char_indices() {
        let is_word_char = ch.is_alphanumeric() || ch == '_';
        if is_word_char {
            if current_start.is_none() {
                current_start = Some(idx);
            }
        } else if let Some(start) = current_start.take() {
            spans.push((start, idx));
        }
    }
    if let Some(start) = current_start {
        spans.push((start, text.len()));
    }
    spans
}

/// Count word tokens in `text` deterministically offline.
#[must_use]
pub fn count_tokens(text: &str) -> usize {
    word_byte_spans(text).len()
}

/// Hard floor: cut `text` at a word boundary so the result never exceeds `max_tokens`.
#[must_use]
pub fn truncate_to_budget(text: &str, max_tokens: usize) -> String {
    let spans = word_byte_spans(text);
    if spans.len() <= max_tokens {
        return text.to_string();
    }
    if max_tokens == 0 {
        return String::new();
    }
    let marker_tokens = count_tokens(TRUNCATION_MARKER);
    let (allowed, with_marker) = if max_tokens > marker_tokens {
        (max_tokens - marker_tokens, true)
    } else {
        (max_tokens, false)
    };
    let kept_end = spans
        .get(allowed.saturating_sub(1))
        .map_or(0, |&(_, end)| end);
    let mut out = text[..kept_end].to_string();
    if with_marker {
        out.push_str(TRUNCATION_MARKER);
    }
    out
}

fn hit_span(hit: &Value) -> Option<(String, u64, u64)> {
    let src = hit.get("_source").unwrap_or(hit);
    let file = ["ax_path", "ax_file", "path", "file"]
        .iter()
        .find_map(|k| src.get(*k).and_then(Value::as_str))?
        .to_string();

    let start = src
        .get("start_line")
        .or_else(|| src.get("line"))
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .or_else(|| {
            hit.pointer("/fields/_passage/0")?
                .get("ordinal")
                .and_then(Value::as_u64)
                .map(|o| o + 1)
        })?;
    let mut end = src
        .get("end_line")
        .and_then(Value::as_u64)
        .unwrap_or(start)
        .max(start);
    if let Some(lines) = passage_line_count(hit) {
        end = end.max(start + lines);
    }
    Some((file, start, end))
}

fn passage_line_count(hit: &Value) -> Option<u64> {
    Some(
        hit.pointer("/fields/_passage/0")?
            .get("text")
            .and_then(Value::as_str)
            .map(|t| t.matches('\n').count() as u64)
            .unwrap_or(0),
    )
}

fn spans_overlap(a: &(String, u64, u64), b: &(String, u64, u64)) -> bool {
    a.0 == b.0 && a.1 <= b.2 && b.1 <= a.2
}

fn locator_stub(hit: &Value) -> Value {
    let mut stub = serde_json::Map::new();
    for k in ["_index", "_id", "id", "identifier", "title", "state"] {
        if let Some(v) = hit.get(k).filter(|v| !v.is_null()) {
            if v.is_string() || v.is_number() {
                stub.insert(k.to_string(), v.clone());
            }
        }
    }
    if let Some(src) = hit.get("_source") {
        for k in [
            "ax_path",
            "path",
            "start_line",
            "line",
            "identifier",
            "title",
        ] {
            if let Some(v) = src.get(k).filter(|v| !v.is_null()) {
                if v.is_string() || v.is_number() {
                    stub.insert(k.to_string(), v.clone());
                }
            }
        }
    }
    Value::Object(stub)
}

fn any_overlaps(hits: &[Value]) -> bool {
    let mut spans: Vec<(String, u64, u64)> = Vec::new();
    for hit in hits {
        if let Some(s) = hit_span(hit) {
            if spans.iter().any(|k| spans_overlap(k, &s)) {
                return true;
            }
            spans.push(s);
        }
    }
    false
}

fn compact(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// Budget a JSON search or issue-list response to `max_tokens` tokens.
///
/// Supports both Elasticsearch/XERJ `hits.hits` envelopes and Linear `issues` / `items` arrays.
#[must_use]
pub fn budget_json_response(engine_text: &str, max_tokens: usize) -> String {
    let Ok(resp) = serde_json::from_str::<Value>(engine_text) else {
        return truncate_to_budget(engine_text, max_tokens);
    };

    // Support XERJ `hits.hits` or Linear `issues` / top-level array shapes
    if let Some(hits) = resp
        .get("hits")
        .and_then(|h| h.get("hits"))
        .and_then(Value::as_array)
        .cloned()
    {
        return budget_hits_array(engine_text, &resp, &hits, max_tokens, true);
    }

    if let Some(issues) = resp.get("issues").and_then(Value::as_array).cloned() {
        return budget_hits_array(engine_text, &resp, &issues, max_tokens, false);
    }

    if count_tokens(engine_text) <= max_tokens {
        return engine_text.to_string();
    }
    truncate_to_budget(engine_text, max_tokens)
}

fn budget_hits_array(
    engine_text: &str,
    resp: &Value,
    hits: &[Value],
    max_tokens: usize,
    is_es_hits: bool,
) -> String {
    if count_tokens(engine_text) <= max_tokens && !any_overlaps(hits) {
        return engine_text.to_string();
    }

    let mut header = resp.clone();
    if is_es_hits {
        if let Some(arr) = header
            .get_mut("hits")
            .and_then(|h| h.get_mut("hits"))
            .and_then(Value::as_array_mut)
        {
            arr.clear();
        }
    } else if let Some(arr) = header.get_mut("issues").and_then(Value::as_array_mut) {
        arr.clear();
    }

    let header_tokens = count_tokens(&compact(&header));
    if header_tokens.saturating_add(NOTE_RESERVE) >= max_tokens {
        let mut bare = header;
        if is_es_hits {
            if let Some(hits_obj) = bare.get_mut("hits").and_then(Value::as_object_mut) {
                hits_obj.remove("hits");
            }
        } else if let Some(obj) = bare.as_object_mut() {
            obj.remove("issues");
        }
        return truncate_to_budget(&compact(&bare), max_tokens);
    }
    let mut remaining = max_tokens - header_tokens - NOTE_RESERVE;

    let mut kept_spans: Vec<(String, u64, u64)> = Vec::new();
    let mut deduped = 0usize;
    let mut full: Vec<Value> = Vec::new();
    let mut locators: Vec<Value> = Vec::new();
    let mut dropped = 0usize;

    for hit in hits {
        let span = hit_span(hit);
        if span
            .as_ref()
            .is_some_and(|s| kept_spans.iter().any(|k| spans_overlap(k, s)))
        {
            deduped += 1;
            continue;
        }
        let hit_tokens = count_tokens(&compact(hit));
        if hit_tokens <= remaining {
            full.push(hit.clone());
            if let Some(s) = span {
                kept_spans.push(s);
            }
            remaining -= hit_tokens;
        } else {
            let stub = locator_stub(hit);
            let stub_tokens = count_tokens(&compact(&stub));
            if stub_tokens <= remaining {
                locators.push(stub);
                remaining -= stub_tokens;
            } else {
                dropped += 1;
            }
        }
    }

    let mut out = header;
    let full_len = full.len();
    if is_es_hits {
        if let Some(arr) = out
            .get_mut("hits")
            .and_then(|h| h.get_mut("hits"))
            .and_then(Value::as_array_mut)
        {
            *arr = full;
        }
    } else if let Some(arr) = out.get_mut("issues").and_then(Value::as_array_mut) {
        *arr = full;
    }

    let accounting = json!({
        "tokenizer": TOKENIZER_ID,
        "max_tokens": max_tokens,
        "hits_full": full_len,
        "hits_locator_only": locators,
        "deduped_overlapping": deduped,
        "hits_dropped": dropped,
    });
    if let Some(obj) = out.as_object_mut() {
        obj.insert("_token_budget".to_string(), accounting);
    }
    let measured = count_tokens(&compact(&out));
    if let Some(tb) = out
        .as_object_mut()
        .and_then(|o| o.get_mut("_token_budget"))
        .and_then(Value::as_object_mut)
    {
        tb.insert(
            "tokens_used".to_string(),
            json!(measured + TOKENS_USED_INSERT),
        );
    }
    let final_text = compact(&out);
    if count_tokens(&final_text) > max_tokens {
        return truncate_to_budget(&final_text, max_tokens);
    }
    final_text
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn count_tokens_and_truncate_never_exceed_budget() {
        assert_eq!(count_tokens("hello, world!"), 2);
        assert_eq!(count_tokens("snake_case_name"), 1);
        assert_eq!(count_tokens(""), 0);

        let text = "word ".repeat(500);
        for n in [1usize, 5, 6, 7, 32, 100] {
            let out = truncate_to_budget(&text, n);
            assert!(count_tokens(&out) <= n, "budget {n}: {out}");
        }
    }

    #[test]
    fn opt_max_tokens_validates_floor() {
        assert_eq!(opt_max_tokens(&json!({})), Ok(None));
        assert_eq!(opt_max_tokens(&json!({ "max_tokens": 500 })), Ok(Some(500)));
        assert!(opt_max_tokens(&json!({ "max_tokens": 31 })).is_err());
    }

    #[test]
    fn budget_json_response_demotes_hits_to_locators_and_dedupes() {
        let hits: Vec<Value> = (1..=10)
            .map(|i| {
                json!({
                    "_index": "ax-code",
                    "_id": format!("hit-{i}"),
                    "_source": {
                        "ax_path": format!("src/f{i}.rs"),
                        "line": i * 10,
                        "body": "let value = compute_work(); ".repeat(15)
                    }
                })
            })
            .collect();
        let resp = compact(&json!({
            "took": 5,
            "hits": { "total": { "value": 10 }, "hits": hits }
        }));

        for b in [32usize, 64, 128, 256, 512, 10_000] {
            let out = budget_json_response(&resp, b);
            assert!(count_tokens(&out) <= b, "exceeded budget {b}");
        }

        let budgeted: Value = serde_json::from_str(&budget_json_response(&resp, 180)).unwrap();
        assert_eq!(budgeted["_token_budget"]["tokenizer"], TOKENIZER_ID);
        assert!(budgeted["_token_budget"]["hits_full"].as_u64().unwrap() < 10);
    }
}
