//! Vector distance metrics, scalar quantization (`SQ8` / `SQ4`), and zero-token
//! deterministic second-stage lexical judge reranking (`xerj-vector` & `xerj-rerank`).
//!
//! All vector distance functions use explicit single-pass loops that LLVM auto-vectorizes
//! (`SSE2`/`AVX2`/`NEON`) without `unsafe` blocks.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::DomainError;

// ============================================================================
// 1. Distance Metrics (xerj-vector/src/distance.rs)
// ============================================================================

/// Distance metric used during vector index construction and similarity search.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DistanceMetric {
    /// Cosine similarity (higher = more similar).
    #[default]
    Cosine,
    /// Squared Euclidean ($L_2^2$) distance (lower = more similar).
    L2,
    /// Dot product / inner product (higher = more similar; assumes normalized vectors).
    DotProduct,
}

/// Cosine similarity between two vectors in `[-1.0, 1.0]`.
#[must_use]
#[inline]
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len(), "vectors must have the same dimension");

    let mut dot = 0.0_f32;
    let mut norm_a = 0.0_f32;
    let mut norm_b = 0.0_f32;

    for (&ai, &bi) in a.iter().zip(b.iter()) {
        dot += ai * bi;
        norm_a += ai * ai;
        norm_b += bi * bi;
    }

    let denom = (norm_a * norm_b).sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

/// Squared Euclidean ($L_2^2$) distance between two vectors.
#[must_use]
#[inline]
pub fn l2_squared(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len(), "vectors must have the same dimension");

    let mut sum = 0.0_f32;
    for (&ai, &bi) in a.iter().zip(b.iter()) {
        let diff = ai - bi;
        sum += diff * diff;
    }
    sum
}

/// Dot product (inner product) of two vectors.
#[must_use]
#[inline]
pub fn dot_product(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len(), "vectors must have the same dimension");

    let mut sum = 0.0_f32;
    for (&ai, &bi) in a.iter().zip(b.iter()) {
        sum += ai * bi;
    }
    sum
}

/// Compute a distance score oriented as **lower = more similar**:
/// - `Cosine`: `1.0 - cosine(a, b)`
/// - `L2`: `l2_squared(a, b)`
/// - `DotProduct`: `-dot_product(a, b)`
#[must_use]
#[inline]
pub fn compute_distance(metric: DistanceMetric, a: &[f32], b: &[f32]) -> f32 {
    match metric {
        DistanceMetric::Cosine => 1.0 - cosine(a, b),
        DistanceMetric::L2 => l2_squared(a, b),
        DistanceMetric::DotProduct => -dot_product(a, b),
    }
}

// ============================================================================
// 2. Scalar Quantization (xerj-vector/src/quantizer.rs)
// ============================================================================

/// Result of quantizing a batch of vectors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuantizedVectors {
    /// Number of vectors.
    pub count: usize,
    /// Vector dimensionality.
    pub dim: usize,
    /// Quantized byte data for all vectors, packed contiguously.
    pub data: QuantizedData,
}

/// Packed quantized vector storage parameterized by quantization scheme.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum QuantizedData {
    /// Raw `f32` (no quantization).
    F32(Vec<f32>),
    /// Scalar-quantized `u8` values (8-bit, 4x compression).
    U8 {
        /// Contiguous `u8` codes (`count * dim` bytes).
        bytes: Vec<u8>,
        /// Per-dimension minimum values for dequantization.
        mins: Vec<f32>,
        /// Per-dimension scales (`max - min`) for dequantization.
        scales: Vec<f32>,
    },
    /// Scalar-quantized 4-bit nibble values packed two-per-byte (8x compression).
    Nibble {
        /// Packed nibble bytes; `ceil(dim/2)` bytes per vector.
        bytes: Vec<u8>,
        /// Per-dimension minimum values for dequantization.
        mins: Vec<f32>,
        /// Per-dimension scales (`max - min`) for dequantization.
        scales: Vec<f32>,
    },
}

impl QuantizedData {
    /// Reconstruct the `f32` vector for a specific index `idx`.
    #[must_use]
    pub fn get_f32(&self, idx: usize, dim: usize) -> Option<Vec<f32>> {
        match self {
            Self::F32(data) => {
                let start = idx * dim;
                let end = start + dim;
                if end <= data.len() {
                    Some(data[start..end].to_vec())
                } else {
                    None
                }
            }
            Self::U8 {
                bytes,
                mins,
                scales,
            } => {
                let start = idx * dim;
                let end = start + dim;
                if end <= bytes.len() {
                    let vec: Vec<f32> = bytes[start..end]
                        .iter()
                        .enumerate()
                        .map(|(d, &b)| mins[d] + (f32::from(b) / 255.0) * scales[d])
                        .collect();
                    Some(vec)
                } else {
                    None
                }
            }
            Self::Nibble {
                bytes,
                mins,
                scales,
            } => {
                let bytes_per_vec = dim.div_ceil(2);
                let byte_start = idx * bytes_per_vec;
                let byte_end = byte_start + bytes_per_vec;
                if byte_end > bytes.len() {
                    return None;
                }
                let mut vec = Vec::with_capacity(dim);
                for d in 0..dim {
                    let byte_idx = byte_start + d / 2;
                    let nibble = if d % 2 == 0 {
                        (bytes[byte_idx] >> 4) & 0x0F
                    } else {
                        bytes[byte_idx] & 0x0F
                    };
                    vec.push(mins[d] + (f32::from(nibble) / 15.0) * scales[d]);
                }
                Some(vec)
            }
        }
    }
}

/// Trait for vector quantizers that compress `f32` vectors for space-efficient storage.
pub trait Quantizer: Send + Sync {
    /// Quantize a batch of vectors.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::ActivityError`] if input vectors have inconsistent dimensions.
    fn quantize(&self, vectors: &[Vec<f32>]) -> Result<QuantizedVectors, DomainError>;

    /// Compute an approximate squared-L2 distance from a full-precision query to a
    /// quantized stored vector by index.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::ActivityError`] if `id` is out of range or the variant mismatches.
    fn distance(
        &self,
        query: &[f32],
        quantized: &QuantizedData,
        id: usize,
    ) -> Result<f32, DomainError>;

    /// Human-readable quantizer name.
    fn name(&self) -> &'static str;
}

/// Passthrough quantizer storing raw `f32` vectors without compression.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoneQuantizer;

impl Quantizer for NoneQuantizer {
    fn quantize(&self, vectors: &[Vec<f32>]) -> Result<QuantizedVectors, DomainError> {
        let dim = vectors.first().map_or(0, Vec::len);
        for v in vectors {
            if v.len() != dim {
                return Err(DomainError::ActivityError(
                    "NoneQuantizer: inconsistent vector dimensions".to_string(),
                ));
            }
        }
        let flat: Vec<f32> = vectors.iter().flat_map(|v| v.iter().copied()).collect();
        Ok(QuantizedVectors {
            count: vectors.len(),
            dim,
            data: QuantizedData::F32(flat),
        })
    }

    fn distance(
        &self,
        query: &[f32],
        quantized: &QuantizedData,
        id: usize,
    ) -> Result<f32, DomainError> {
        let dim = query.len();
        let stored = quantized.get_f32(id, dim).ok_or_else(|| {
            DomainError::ActivityError(format!("NoneQuantizer: id {id} out of range"))
        })?;
        Ok(l2_squared(query, &stored))
    }

    fn name(&self) -> &'static str {
        "none"
    }
}

/// 8-bit scalar quantizer (`SQ8`, 4x memory compression).
#[derive(Debug, Default, Clone, Copy)]
pub struct Scalar8Quantizer;

impl Scalar8Quantizer {
    #[inline]
    fn encode_dim(value: f32, min: f32, scale: f32) -> u8 {
        if scale == 0.0 {
            return 0;
        }
        let normalized = (value - min) / scale;
        (normalized * 255.0).round().clamp(0.0, 255.0) as u8
    }

    #[inline]
    fn decode_dim(byte: u8, min: f32, scale: f32) -> f32 {
        min + (f32::from(byte) / 255.0) * scale
    }
}

impl Quantizer for Scalar8Quantizer {
    fn quantize(&self, vectors: &[Vec<f32>]) -> Result<QuantizedVectors, DomainError> {
        if vectors.is_empty() {
            return Ok(QuantizedVectors {
                count: 0,
                dim: 0,
                data: QuantizedData::U8 {
                    bytes: Vec::new(),
                    mins: Vec::new(),
                    scales: Vec::new(),
                },
            });
        }

        let dim = vectors[0].len();
        let mut mins = vec![f32::MAX; dim];
        let mut maxs = vec![f32::MIN; dim];

        for vec in vectors {
            if vec.len() != dim {
                return Err(DomainError::ActivityError(
                    "Scalar8Quantizer: inconsistent vector dimensions".to_string(),
                ));
            }
            for (d, &v) in vec.iter().enumerate() {
                if v < mins[d] {
                    mins[d] = v;
                }
                if v > maxs[d] {
                    maxs[d] = v;
                }
            }
        }

        let scales: Vec<f32> = mins
            .iter()
            .zip(maxs.iter())
            .map(|(&mn, &mx)| mx - mn)
            .collect();

        let mut bytes = Vec::with_capacity(vectors.len() * dim);
        for vec in vectors {
            for (d, &v) in vec.iter().enumerate() {
                bytes.push(Self::encode_dim(v, mins[d], scales[d]));
            }
        }

        Ok(QuantizedVectors {
            count: vectors.len(),
            dim,
            data: QuantizedData::U8 {
                bytes,
                mins,
                scales,
            },
        })
    }

    fn distance(
        &self,
        query: &[f32],
        quantized: &QuantizedData,
        id: usize,
    ) -> Result<f32, DomainError> {
        let QuantizedData::U8 {
            bytes,
            mins,
            scales,
        } = quantized
        else {
            return Err(DomainError::ActivityError(
                "Scalar8Quantizer: wrong QuantizedData variant".to_string(),
            ));
        };

        let dim = query.len();
        let start = id * dim;
        let end = start + dim;
        if end > bytes.len() {
            return Err(DomainError::ActivityError(format!(
                "Scalar8Quantizer: id {id} out of range"
            )));
        }

        let dist: f32 = query
            .iter()
            .enumerate()
            .map(|(d, &q)| {
                let stored = Self::decode_dim(bytes[start + d], mins[d], scales[d]);
                let diff = q - stored;
                diff * diff
            })
            .sum();

        Ok(dist)
    }

    fn name(&self) -> &'static str {
        "scalar8"
    }
}

/// Serializable per-dimension `SQ8` codec parameters for serving-path encoding/decoding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sq8Params {
    /// Per-dimension minimum value.
    pub mins: Vec<f32>,
    /// Per-dimension scale (`max - min`).
    pub scales: Vec<f32>,
}

impl Sq8Params {
    /// Fit per-dimension min/max over `sample`.
    #[must_use]
    pub fn fit(sample: &[Vec<f32>], dim: usize) -> Self {
        Self::fit_borrowed(sample.iter().map(Vec::as_slice), dim)
    }

    /// Fit per-dimension min/max over borrowed vector slices.
    #[must_use]
    pub fn fit_borrowed<'a, I>(sample: I, dim: usize) -> Self
    where
        I: IntoIterator<Item = &'a [f32]>,
    {
        let mut mins = vec![f32::MAX; dim];
        let mut maxs = vec![f32::MIN; dim];
        let mut seen = false;
        for v in sample {
            if v.len() != dim {
                continue;
            }
            seen = true;
            for (d, &x) in v.iter().enumerate() {
                if x < mins[d] {
                    mins[d] = x;
                }
                if x > maxs[d] {
                    maxs[d] = x;
                }
            }
        }
        if !seen {
            mins = vec![0.0; dim];
            maxs = vec![0.0; dim];
        }
        let scales = mins
            .iter()
            .zip(maxs.iter())
            .map(|(&mn, &mx)| mx - mn)
            .collect();
        Self { mins, scales }
    }

    /// Vector dimensionality this codec was fitted for.
    #[must_use]
    #[inline]
    pub fn dim(&self) -> usize {
        self.mins.len()
    }

    /// Encode a full-precision vector to one `u8` per dimension.
    #[must_use]
    #[inline]
    pub fn encode(&self, v: &[f32]) -> Vec<u8> {
        let mut out = vec![0_u8; v.len()];
        self.encode_into(v, &mut out);
        out
    }

    /// Encode into a caller-provided buffer.
    #[inline]
    pub fn encode_into(&self, v: &[f32], out: &mut [u8]) {
        for (d, &x) in v.iter().enumerate() {
            let min = self.mins.get(d).copied().unwrap_or(0.0);
            let scale = self.scales.get(d).copied().unwrap_or(0.0);
            if scale == 0.0 {
                out[d] = 0_u8;
                continue;
            }
            let normalized = (x - min) / scale;
            out[d] = (normalized * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }

    /// Decode a code slice back to approximate `f32` values.
    #[must_use]
    #[inline]
    pub fn decode(&self, codes: &[u8]) -> Vec<f32> {
        let mut out = vec![0.0_f32; codes.len()];
        self.decode_into(codes, &mut out);
        out
    }

    /// Decode into a caller-provided buffer.
    #[inline]
    pub fn decode_into(&self, codes: &[u8], out: &mut [f32]) {
        for (d, &b) in codes.iter().enumerate() {
            let min = self.mins.get(d).copied().unwrap_or(0.0);
            let scale = self.scales.get(d).copied().unwrap_or(0.0);
            out[d] = min + (f32::from(b) / 255.0) * scale;
        }
    }
}

/// 4-bit scalar quantizer (`SQ4`, 8x memory compression via packed nibbles).
#[derive(Debug, Default, Clone, Copy)]
pub struct Scalar4Quantizer;

impl Scalar4Quantizer {
    #[inline]
    fn encode_dim(value: f32, min: f32, scale: f32) -> u8 {
        if scale == 0.0 {
            return 0;
        }
        let normalized = (value - min) / scale;
        (normalized * 15.0).round().clamp(0.0, 15.0) as u8
    }

    #[inline]
    fn decode_dim(nibble: u8, min: f32, scale: f32) -> f32 {
        min + (f32::from(nibble) / 15.0) * scale
    }
}

impl Quantizer for Scalar4Quantizer {
    fn quantize(&self, vectors: &[Vec<f32>]) -> Result<QuantizedVectors, DomainError> {
        if vectors.is_empty() {
            return Ok(QuantizedVectors {
                count: 0,
                dim: 0,
                data: QuantizedData::Nibble {
                    bytes: Vec::new(),
                    mins: Vec::new(),
                    scales: Vec::new(),
                },
            });
        }

        let dim = vectors[0].len();
        let mut mins = vec![f32::MAX; dim];
        let mut maxs = vec![f32::MIN; dim];

        for vec in vectors {
            if vec.len() != dim {
                return Err(DomainError::ActivityError(
                    "Scalar4Quantizer: inconsistent vector dimensions".to_string(),
                ));
            }
            for (d, &v) in vec.iter().enumerate() {
                if v < mins[d] {
                    mins[d] = v;
                }
                if v > maxs[d] {
                    maxs[d] = v;
                }
            }
        }

        let scales: Vec<f32> = mins
            .iter()
            .zip(maxs.iter())
            .map(|(&mn, &mx)| mx - mn)
            .collect();

        let bytes_per_vec = dim.div_ceil(2);
        let mut bytes = Vec::with_capacity(vectors.len() * bytes_per_vec);

        for vec in vectors {
            let mut d = 0;
            while d < dim {
                let hi = Self::encode_dim(vec[d], mins[d], scales[d]);
                let lo = if d + 1 < dim {
                    Self::encode_dim(vec[d + 1], mins[d + 1], scales[d + 1])
                } else {
                    0_u8
                };
                bytes.push((hi << 4) | (lo & 0x0F));
                d += 2;
            }
        }

        Ok(QuantizedVectors {
            count: vectors.len(),
            dim,
            data: QuantizedData::Nibble {
                bytes,
                mins,
                scales,
            },
        })
    }

    fn distance(
        &self,
        query: &[f32],
        quantized: &QuantizedData,
        id: usize,
    ) -> Result<f32, DomainError> {
        let QuantizedData::Nibble {
            bytes,
            mins,
            scales,
        } = quantized
        else {
            return Err(DomainError::ActivityError(
                "Scalar4Quantizer: wrong QuantizedData variant".to_string(),
            ));
        };

        let dim = query.len();
        let bytes_per_vec = dim.div_ceil(2);
        let byte_start = id * bytes_per_vec;
        let byte_end = byte_start + bytes_per_vec;

        if byte_end > bytes.len() {
            return Err(DomainError::ActivityError(format!(
                "Scalar4Quantizer: id {id} out of range"
            )));
        }

        let dist: f32 = (0..dim)
            .map(|d| {
                let byte_idx = byte_start + d / 2;
                let nibble = if d % 2 == 0 {
                    (bytes[byte_idx] >> 4) & 0x0F
                } else {
                    bytes[byte_idx] & 0x0F
                };
                let stored = Self::decode_dim(nibble, mins[d], scales[d]);
                let diff = query[d] - stored;
                diff * diff
            })
            .sum();

        Ok(dist)
    }

    fn name(&self) -> &'static str {
        "scalar4"
    }
}

// ============================================================================
// 3. Zero-Token Second-Stage Lexical Judge (xerj-rerank/src/judge.rs)
// ============================================================================

/// Valid probability range for `judge.min_p`.
pub const MIN_P_RANGE: (f64, f64) = (0.0, 1.0);

/// Maximum query characters accepted by the local judge (`2048`).
pub const MAX_QUERY_CHARS: usize = 2048;

/// Maximum unknown key characters echoed in error messages.
const MAX_ECHOED_NAME_CHARS: usize = 64;

/// Parsed `judge` configuration block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JudgeConfig {
    /// Optional explicit question to judge candidates against.
    pub query: Option<String>,
    /// Optional minimum relevance probability threshold (`0.0..=1.0`).
    pub min_p: Option<f64>,
}

impl JudgeConfig {
    /// Parse a [`JudgeConfig`] from a JSON object, rejecting unknown fields or invalid ranges.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidFlow`] if the JSON object is malformed.
    pub fn from_json(v: &Value) -> Result<Self, DomainError> {
        let obj = v
            .as_object()
            .ok_or_else(|| DomainError::InvalidFlow("`judge` must be an object".into()))?;

        const KNOWN: &[&str] = &["local", "min_p", "query"];
        for k in obj.keys() {
            if !KNOWN.contains(&k.as_str()) {
                let shown: String = k.chars().take(MAX_ECHOED_NAME_CHARS).collect();
                let ellipsis = if shown.len() < k.len() { "..." } else { "" };
                return Err(DomainError::InvalidFlow(format!(
                    "unknown `judge` field `{shown}{ellipsis}`; supported: {}",
                    KNOWN.join(", ")
                )));
            }
        }

        if let Some(l) = obj.get("local") {
            match l {
                Value::Bool(true) => {}
                Value::Bool(false) => {
                    return Err(DomainError::InvalidFlow(
                        "`judge.local` cannot be false: the local judge is the only judge".into(),
                    ));
                }
                _ => {
                    return Err(DomainError::InvalidFlow(
                        "`judge.local` must be true (the local judge is the only judge)".into(),
                    ));
                }
            }
        }

        let min_p = match obj.get("min_p") {
            None => None,
            Some(t) => {
                let t = t.as_f64().ok_or_else(|| {
                    DomainError::InvalidFlow("`judge.min_p` must be a number".into())
                })?;
                if !(MIN_P_RANGE.0..=MIN_P_RANGE.1).contains(&t) {
                    return Err(DomainError::InvalidFlow(
                        "`judge.min_p` must be between 0 and 1".into(),
                    ));
                }
                Some(t)
            }
        };

        let query = match obj.get("query") {
            None => None,
            Some(q) => {
                let q = q.as_str().ok_or_else(|| {
                    DomainError::InvalidFlow("`judge.query` must be a string".into())
                })?;
                if q.chars().count() > MAX_QUERY_CHARS {
                    return Err(DomainError::InvalidFlow(format!(
                        "`judge.query` must be at most {MAX_QUERY_CHARS} characters"
                    )));
                }
                if q.trim().is_empty() {
                    return Err(DomainError::InvalidFlow(
                        "`judge.query` must not be empty".into(),
                    ));
                }
                Some(q.to_string())
            }
        };

        Ok(Self { query, min_p })
    }
}

/// Candidate document or Linear issue passed to the second-stage lexical judge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JudgeCandidate {
    /// Caller's 0-based position in the first-stage hit list.
    pub ordinal: usize,
    /// Optional document or issue title.
    pub title: Option<String>,
    /// Document or issue body text.
    pub text: String,
}

/// Relevance probability (`0.0..=1.0`) produced by the second-stage judge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoredCandidate {
    /// Original candidate ordinal.
    pub ordinal: usize,
    /// Calibrated window-local BM25 saturation probability in `0.0..=1.0`.
    pub score: f64,
}

const JUDGE_K1: f64 = 1.2;
const JUDGE_B: f64 = 0.75;

fn judge_tokens(s: &str) -> impl Iterator<Item = String> + '_ {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
}

/// Score each candidate into a deterministic relevance probability (`0.0..=1.0`)
/// using window-local BM25 saturation and page-local IDF (`xerj-rerank` #1060).
#[must_use]
pub fn lexical_scores(query: &str, candidates: &[JudgeCandidate]) -> Vec<ScoredCandidate> {
    let mut q_terms: Vec<String> = Vec::new();
    {
        let mut seen: HashSet<String> = HashSet::new();
        for t in judge_tokens(query) {
            if seen.insert(t.clone()) {
                q_terms.push(t);
            }
        }
    }
    if q_terms.is_empty() || candidates.is_empty() {
        return candidates
            .iter()
            .map(|c| ScoredCandidate {
                ordinal: c.ordinal,
                score: 0.0,
            })
            .collect();
    }

    let docs: Vec<Vec<String>> = candidates
        .iter()
        .map(|c| {
            let mut ts: Vec<String> = Vec::new();
            if let Some(t) = &c.title {
                ts.extend(judge_tokens(t));
            }
            ts.extend(judge_tokens(&c.text));
            ts
        })
        .collect();

    let n = docs.len() as f64;
    let avgdl = {
        let total: usize = docs.iter().map(Vec::len).sum();
        (total as f64 / n).max(1.0)
    };

    let idf: Vec<f64> = q_terms
        .iter()
        .map(|q| {
            let df = docs.iter().filter(|d| d.iter().any(|t| t == q)).count() as f64;
            (1.0 + (n - df + 0.5) / (df + 0.5)).ln()
        })
        .collect();
    let max_score: f64 = idf.iter().sum::<f64>() * (JUDGE_K1 + 1.0);

    let qset: HashSet<&str> = q_terms.iter().map(String::as_str).collect();
    candidates
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let d = &docs[i];
            let norm = JUDGE_K1 * (1.0 - JUDGE_B + JUDGE_B * d.len() as f64 / avgdl);
            let mut tf: HashMap<&str, u64> = HashMap::new();
            for t in d {
                if qset.contains(t.as_str()) {
                    *tf.entry(t.as_str()).or_insert(0) += 1;
                }
            }
            let numerator: f64 = idf
                .iter()
                .zip(q_terms.iter())
                .map(|(w, q)| {
                    let tf_val = tf.get(q.as_str()).copied().unwrap_or(0) as f64;
                    w * (tf_val * (JUDGE_K1 + 1.0) / (tf_val + norm))
                })
                .sum();
            ScoredCandidate {
                ordinal: c.ordinal,
                score: (numerator / max_score).clamp(0.0, 1.0),
            }
        })
        .collect()
}

/// Judge candidates with [`lexical_scores`], filter out hits below `min_p` (if set),
/// and sort descending by probability (breaking ties by original `ordinal`).
#[must_use]
pub fn judge_and_filter(
    query: &str,
    candidates: &[JudgeCandidate],
    min_p: Option<f64>,
) -> Vec<ScoredCandidate> {
    let threshold = min_p.unwrap_or(0.0);
    let mut scored: Vec<ScoredCandidate> = lexical_scores(query, candidates)
        .into_iter()
        .filter(|s| s.score >= threshold)
        .collect();
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.ordinal.cmp(&b.ordinal))
    });
    scored
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn distance_metrics_work() {
        let a = vec![1.0_f32, 0.0];
        let b = vec![0.0_f32, 1.0];
        assert!((cosine(&a, &a) - 1.0).abs() < 1e-5);
        assert!(cosine(&a, &b).abs() < 1e-5);
        assert!((l2_squared(&[0.0, 0.0], &[3.0, 4.0]) - 25.0).abs() < 1e-5);
        assert!(compute_distance(DistanceMetric::Cosine, &a, &b) >= 0.0);
    }

    #[test]
    fn scalar8_and_scalar4_preserve_distance_order_and_compress_memory() {
        let vecs = vec![vec![1.0_f32, 0.0, 0.0], vec![0.0_f32, 0.0, 1.0]];
        let q8 = Scalar8Quantizer;
        let q4 = Scalar4Quantizer;

        let qv8 = q8.quantize(&vecs).unwrap();
        let qv4 = q4.quantize(&vecs).unwrap();

        let query = vec![1.0_f32, 0.0, 0.0];
        assert!(
            q8.distance(&query, &qv8.data, 0).unwrap() < q8.distance(&query, &qv8.data, 1).unwrap()
        );
        assert!(
            q4.distance(&query, &qv4.data, 0).unwrap() < q4.distance(&query, &qv4.data, 1).unwrap()
        );

        let params = Sq8Params::fit(&vecs, 3);
        let encoded = params.encode(&vecs[0]);
        let decoded = params.decode(&encoded);
        assert!((decoded[0] - 1.0).abs() < 0.02);
    }

    #[test]
    fn lexical_judge_orders_by_coverage_and_filters_by_min_p() {
        let cfg = JudgeConfig::from_json(&json!({"local": true, "min_p": 0.2})).unwrap();
        let cands = vec![
            JudgeCandidate {
                ordinal: 0,
                title: Some("Cooking".into()),
                text: "vitamin rich vegetables for dinner".into(),
            },
            JudgeCandidate {
                ordinal: 1,
                title: Some("Trial results".into()),
                text: "vitamin d supplementation improved bone density in the treatment group"
                    .into(),
            },
            JudgeCandidate {
                ordinal: 2,
                title: None,
                text: "nothing about the topic at all".into(),
            },
        ];

        let ranked = judge_and_filter("vitamin d supplementation bone density", &cands, cfg.min_p);
        assert!(!ranked.is_empty());
        assert_eq!(ranked[0].ordinal, 1);
        assert!(ranked.iter().all(|s| s.ordinal != 2));
    }
}
