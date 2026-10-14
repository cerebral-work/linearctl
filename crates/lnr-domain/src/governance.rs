//! Resource governor circuit breakers, RBAC role descriptors, tamper-evident WORM
//! audit hash chains, slow-query ring buffers, and pure-string editorial & link-safety
//! denylist checkers (`xerj-engine` & `science::site_check`).

use std::collections::{BTreeMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::claims::{is_valid_date, is_valid_source_ref};
use crate::crypto::sha256_hex;

// ============================================================================
// 1. Resource Governor & Memory/Disk Circuit Breakers (xerj-engine/src/governor.rs)
// ============================================================================

/// Configuration for the process-wide resource governor and circuit breakers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceGovernorConfig {
    /// Effective cgroup or system memory limit in bytes.
    pub effective_memory_limit_bytes: u64,
    /// Optional explicit process memory cap in MiB (`0` = uncapped, `u64::MAX` = auto tier).
    pub max_process_memory_mb: u64,
    /// Optional explicit memtable budget in MiB (`0` = auto-derived 25% of memory limit).
    pub max_total_memtable_mb: u64,
    /// RSS admission watermark percentage (`0..=100`, e.g. `85`).
    pub memory_watermark_percent: u8,
    /// Per-query estimated allocation ceiling in MiB (`0` = disabled).
    pub max_query_memory_mb: u64,
    /// Disk flood-stage write-block percentage (`0..=100`, e.g. `95`).
    pub disk_flood_stage_percent: u8,
}

impl Default for ResourceGovernorConfig {
    fn default() -> Self {
        Self {
            effective_memory_limit_bytes: 16 * 1024 * 1024 * 1024,
            max_process_memory_mb: u64::MAX,
            max_total_memtable_mb: 0,
            memory_watermark_percent: 85,
            max_query_memory_mb: 512,
            disk_flood_stage_percent: 95,
        }
    }
}

/// Auto-tiered process memory cap in MiB (`< 64 GiB -> 8 GiB`, `< 128 GiB -> 16 GiB`, `>= 128 GiB -> 32 GiB`).
#[must_use]
pub const fn tiered_cap_mb(effective_bytes: u64) -> u64 {
    const GIB: u64 = 1024 * 1024 * 1024;
    if effective_bytes < 64 * GIB {
        8 * 1024
    } else if effective_bytes < 128 * GIB {
        16 * 1024
    } else {
        32 * 1024
    }
}

/// Auto-derive the memtable byte ceiling from the effective memory limit:
/// 25% of the limit, floored at 2 GiB, capped at 50% of the limit.
#[must_use]
pub fn auto_memtable_budget(effective_limit: u64) -> u64 {
    (effective_limit / 4)
        .max(2 * 1024 * 1024 * 1024)
        .min(effective_limit / 2)
}

/// Verdict returned by a resource governor admission check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CircuitBreakerVerdict {
    /// Request is admitted within resource budgets.
    Admitted,
    /// Request is rejected (`429 circuit_breaking_exception`) with a diagnostic reason.
    Tripped(String),
}

impl CircuitBreakerVerdict {
    /// Returns `true` if the request was admitted.
    #[must_use]
    pub const fn is_admitted(&self) -> bool {
        matches!(self, Self::Admitted)
    }
}

/// Deterministic state machine for process-wide memory, memtable, query, and disk circuit breakers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceGovernorState {
    /// Effective capped memory limit in bytes.
    pub memory_limit_bytes: u64,
    /// RSS admission watermark in bytes.
    pub memory_watermark_bytes: u64,
    /// Summed memtable budget in bytes.
    pub memtable_budget_bytes: u64,
    /// Per-query memory allocation limit in bytes.
    pub max_query_memory_bytes: u64,
    /// Effective disk flood-stage watermark percentage.
    pub disk_flood_pct: u8,
    /// Last sampled summed memtable footprint in bytes.
    pub memtable_used_bytes: u64,
    /// Whether the memtable circuit breaker is currently tripped.
    pub memtable_tripped: bool,
    /// Last sampled process RSS in bytes.
    pub rss_bytes: u64,
    /// Whether the RSS memory circuit breaker is currently tripped.
    pub memory_tripped: bool,
    /// Last sampled disk usage percentage.
    pub disk_used_pct: u64,
    /// Whether the disk flood-stage write block (`read_only_allow_delete`) is latched.
    pub disk_blocked: bool,
}

impl ResourceGovernorState {
    /// Construct a [`ResourceGovernorState`] from [`ResourceGovernorConfig`].
    #[must_use]
    pub fn from_config(cfg: &ResourceGovernorConfig) -> Self {
        let cap_mb = if cfg.max_process_memory_mb == u64::MAX {
            tiered_cap_mb(cfg.effective_memory_limit_bytes)
        } else {
            cfg.max_process_memory_mb
        };
        let memory_limit_bytes = if cap_mb == 0 {
            cfg.effective_memory_limit_bytes
        } else {
            cfg.effective_memory_limit_bytes
                .min(cap_mb.saturating_mul(1024 * 1024))
        };
        let memtable_budget_bytes = if cfg.max_total_memtable_mb != 0 {
            cfg.max_total_memtable_mb.saturating_mul(1024 * 1024)
        } else {
            auto_memtable_budget(memory_limit_bytes)
        };
        let memory_watermark_bytes = if cfg.memory_watermark_percent == 0 {
            0
        } else {
            let pct = u64::from(cfg.memory_watermark_percent.min(100));
            ((u128::from(memory_limit_bytes) * u128::from(pct)) / 100) as u64
        };
        Self {
            memory_limit_bytes,
            memory_watermark_bytes,
            memtable_budget_bytes,
            max_query_memory_bytes: cfg.max_query_memory_mb.saturating_mul(1024 * 1024),
            disk_flood_pct: cfg.disk_flood_stage_percent.min(100),
            memtable_used_bytes: 0,
            memtable_tripped: false,
            rss_bytes: 0,
            memory_tripped: false,
            disk_used_pct: 0,
            disk_blocked: false,
        }
    }

    /// Update sampled resource metrics (`memtable_used`, `rss`, `disk_used_pct`) with
    /// 1% hysteresis on disk flood-stage release.
    pub fn refresh(&mut self, memtable_used: u64, rss: u64, disk_used_pct: u64) {
        self.memtable_used_bytes = memtable_used;
        self.memtable_tripped =
            self.memtable_budget_bytes != 0 && memtable_used >= self.memtable_budget_bytes;

        self.rss_bytes = rss;
        self.memory_tripped =
            self.memory_watermark_bytes != 0 && rss >= self.memory_watermark_bytes;

        if self.disk_flood_pct != 0 {
            self.disk_used_pct = disk_used_pct;
            let release_pct = u64::from(self.disk_flood_pct).saturating_sub(1);
            self.disk_blocked = if self.disk_blocked {
                disk_used_pct >= release_pct
            } else {
                disk_used_pct >= u64::from(self.disk_flood_pct)
            };
        }
    }

    /// Check ingest admission against the memtable and RSS circuit breakers.
    #[must_use]
    pub fn check_ingest_admission(&self) -> CircuitBreakerVerdict {
        if self.memtable_tripped {
            return CircuitBreakerVerdict::Tripped(format!(
                "[parent] memtable byte budget exceeded: used={}MB, limit={}MB",
                self.memtable_used_bytes / (1024 * 1024),
                self.memtable_budget_bytes / (1024 * 1024),
            ));
        }
        if self.memory_tripped {
            return CircuitBreakerVerdict::Tripped(format!(
                "[parent] real memory circuit breaker tripped: rss={}MB >= watermark={}MB",
                self.rss_bytes / (1024 * 1024),
                self.memory_watermark_bytes / (1024 * 1024),
            ));
        }
        CircuitBreakerVerdict::Admitted
    }

    /// Check disk flood-stage write admission for `index`.
    #[must_use]
    pub fn check_disk_block(&self, index: &str) -> CircuitBreakerVerdict {
        if self.disk_blocked {
            return CircuitBreakerVerdict::Tripped(format!(
                "index [{index}] blocked: read_only_allow_delete (disk usage {}% exceeded flood-stage watermark [{}%])",
                self.disk_used_pct, self.disk_flood_pct
            ));
        }
        CircuitBreakerVerdict::Admitted
    }

    /// Check whether a single query's estimated peak allocation (`bytes`) fits within `max_query_memory_bytes`.
    #[must_use]
    pub fn check_query_alloc(&self, bytes: u64, label: &str) -> CircuitBreakerVerdict {
        if self.max_query_memory_bytes != 0 && bytes > self.max_query_memory_bytes {
            return CircuitBreakerVerdict::Tripped(format!(
                "[request] query allocation ({}MB) would exceed max_query_memory_mb={}MB at [{label}]",
                bytes / (1024 * 1024),
                self.max_query_memory_bytes / (1024 * 1024),
            ));
        }
        CircuitBreakerVerdict::Admitted
    }
}

// ============================================================================
// 2. Role-Based Access Control (xerj-engine/src/rbac.rs)
// ============================================================================

/// Core RBAC privileges enforced across index, snapshot, security, and audit surfaces.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Privilege {
    /// Read documents and run searches/aggregations.
    ReadIndex,
    /// Write (index, update, delete, bulk).
    WriteIndex,
    /// Admin (create / delete / settings / mappings).
    AdminIndex,
    /// Take snapshots.
    SnapshotCreate,
    /// Restore from snapshot.
    SnapshotRestore,
    /// Manage roles, users, and API keys.
    SecurityAdmin,
    /// Read the audit log.
    AuditRead,
}

/// An RBAC role binding a set of [`Privilege`]s to index glob patterns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Role {
    /// Role identifier (or `{descriptor}[{i}]`).
    pub name: String,
    /// Granted privileges.
    pub privileges: HashSet<Privilege>,
    /// Glob patterns of index names the role applies to (`"*"` = all).
    pub indices: Vec<String>,
}

impl Role {
    /// Construct a new [`Role`].
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        privileges: HashSet<Privilege>,
        indices: Vec<String>,
    ) -> Self {
        Self {
            name: name.into(),
            privileges,
            indices,
        }
    }

    /// Return the base `role_descriptors` key this role came from, stripping any trailing `[<digits>]`.
    #[must_use]
    pub fn descriptor_name(&self) -> &str {
        let Some(open) = self.name.rfind('[') else {
            return &self.name;
        };
        let Some(digits) = self.name[open + 1..].strip_suffix(']') else {
            return &self.name;
        };
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return &self.name;
        }
        &self.name[..open]
    }

    /// Check whether this role's index patterns match `idx`.
    #[must_use]
    pub fn applies_to(&self, idx: &str) -> bool {
        for pat in &self.indices {
            if pat == "*" || pat == idx {
                return true;
            }
            if let Some(prefix) = pat.strip_suffix('*') {
                if idx.starts_with(prefix) {
                    return true;
                }
            }
        }
        false
    }

    /// Check whether this role grants privilege `p` on index `idx`.
    #[must_use]
    pub fn allows(&self, idx: &str, p: Privilege) -> bool {
        self.applies_to(idx) && self.privileges.contains(&p)
    }
}

/// Map an Elasticsearch index-privilege name onto [`Privilege`]s (fail-closed on unknown names).
#[must_use]
pub fn es_index_privilege(name: &str) -> &'static [Privilege] {
    use Privilege::{AdminIndex, ReadIndex, WriteIndex};
    match name {
        "all" => &[ReadIndex, WriteIndex, AdminIndex],
        "read" | "read_cross_cluster" | "view_index_metadata" | "monitor" => &[ReadIndex],
        "write" | "index" | "create" | "create_doc" | "delete" | "maintenance" => &[WriteIndex],
        "manage" | "create_index" | "delete_index" | "manage_ilm" | "manage_follow_index" => {
            &[AdminIndex]
        }
        _ => &[],
    }
}

/// Map an Elasticsearch cluster-privilege name onto enforced cluster [`Privilege`]s (`read_audit` only).
#[must_use]
pub fn es_cluster_privilege(name: &str) -> &'static [Privilege] {
    match name {
        "read_audit" => &[Privilege::AuditRead],
        _ => &[],
    }
}

/// Parse an Elasticsearch-shaped `role_descriptors` JSON object into enforced [`Role`]s.
#[must_use]
pub fn roles_from_role_descriptors(descriptors: &Value) -> Vec<Role> {
    let Some(map) = descriptors.as_object() else {
        return Vec::new();
    };
    let mut roles = Vec::new();
    for (descriptor_name, descriptor) in map {
        if let Some(cluster) = descriptor.get("cluster").and_then(Value::as_array) {
            let privileges: HashSet<Privilege> = cluster
                .iter()
                .filter_map(Value::as_str)
                .flat_map(|p| es_cluster_privilege(p).iter().copied())
                .collect();
            if !privileges.is_empty() {
                roles.push(Role::new(
                    format!("{descriptor_name}[cluster]"),
                    privileges,
                    vec!["*".to_string()],
                ));
            }
        }
        let Some(entries) = descriptor.get("indices").and_then(Value::as_array) else {
            continue;
        };
        for (i, entry) in entries.iter().enumerate() {
            let names: Vec<String> = entry
                .get("names")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default();
            let privileges: HashSet<Privilege> = entry
                .get("privileges")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .flat_map(|p| es_index_privilege(p).iter().copied())
                        .collect()
                })
                .unwrap_or_default();
            if names.is_empty() || privileges.is_empty() {
                continue;
            }
            roles.push(Role::new(
                format!("{descriptor_name}[{i}]"),
                privileges,
                names,
            ));
        }
    }
    roles
}

/// Return the six canonical seeded roles (`admin`, `write`, `read`, `read_only_index`, `snapshot_admin`, `auditor`).
#[must_use]
pub fn default_roles() -> Vec<Role> {
    use Privilege::{
        AdminIndex, AuditRead, ReadIndex, SecurityAdmin, SnapshotCreate, SnapshotRestore,
        WriteIndex,
    };
    vec![
        Role::new(
            "admin",
            [
                ReadIndex,
                WriteIndex,
                AdminIndex,
                SnapshotCreate,
                SnapshotRestore,
                SecurityAdmin,
                AuditRead,
            ]
            .into_iter()
            .collect(),
            vec!["*".into()],
        ),
        Role::new(
            "write",
            [ReadIndex, WriteIndex].into_iter().collect(),
            vec!["*".into()],
        ),
        Role::new("read", [ReadIndex].into_iter().collect(), vec!["*".into()]),
        Role::new("read_only_index", [ReadIndex].into_iter().collect(), vec![]),
        Role::new(
            "snapshot_admin",
            [SnapshotCreate, SnapshotRestore].into_iter().collect(),
            vec!["*".into()],
        ),
        Role::new(
            "auditor",
            [AuditRead].into_iter().collect(),
            vec!["*".into()],
        ),
    ]
}

// ============================================================================
// 3. Tamper-Evident WORM Audit Hash Chain (xerj-engine/src/audit.rs)
// ============================================================================

/// Default audit ring buffer capacity (`4096`).
pub const DEFAULT_AUDIT_CAPACITY: usize = 4096;

fn default_actor() -> String {
    "user".to_string()
}

/// One entry in the tamper-evident SHA-256 WORM audit hash chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    /// Monotonically increasing sequence number (starts at 1).
    pub seq: u64,
    /// Wall-clock milliseconds since Unix epoch.
    pub at_ms: u64,
    /// Operation tag (e.g. `"search"`, `"index"`, `"delete"`, `"admin.role.put"`).
    pub op: String,
    /// Subject principal (user / API key / OIDC sub).
    pub subject: String,
    /// Target resource (index name, role name, issue ID).
    pub resource: String,
    /// Outcome (`"ok"`, `"denied"`, `"error"`).
    pub outcome: String,
    /// Actor class (`"user"` or `"machine"`).
    #[serde(default = "default_actor")]
    pub actor: String,
    /// Optional short context note.
    pub note: String,
    /// SHA-256 hex digest chained over `prev_hash` and this entry's fields.
    pub hash: String,
}

/// Compute the SHA-256 chain hash for an [`AuditEntry`] given `prev_hash`.
#[must_use]
pub fn compute_audit_hash(prev_hash: &str, entry: &AuditEntry) -> String {
    let mut buf = Vec::with_capacity(128 + entry.op.len() + entry.subject.len() + entry.note.len());
    buf.extend_from_slice(prev_hash.as_bytes());
    buf.extend_from_slice(&entry.seq.to_le_bytes());
    buf.extend_from_slice(&entry.at_ms.to_le_bytes());
    buf.extend_from_slice(entry.op.as_bytes());
    buf.push(0);
    buf.extend_from_slice(entry.subject.as_bytes());
    buf.push(0);
    buf.extend_from_slice(entry.resource.as_bytes());
    buf.push(0);
    buf.extend_from_slice(entry.outcome.as_bytes());
    buf.push(0);
    buf.extend_from_slice(entry.actor.as_bytes());
    buf.push(0);
    buf.extend_from_slice(entry.note.as_bytes());
    sha256_hex(&buf)
}

/// Bounded in-memory WORM audit chain with rotation anchor preservation (`head_prev_hash`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditChain {
    /// Retained entries in chronological order.
    pub entries: VecDeque<AuditEntry>,
    /// Hash that `entries[0]` chains over (`"0".repeat(64)` before any rotation).
    pub head_prev_hash: String,
    /// Maximum retained entries before rotating the oldest entry into `head_prev_hash`.
    pub capacity: usize,
    /// Next sequence number to assign.
    pub next_seq: u64,
}

impl AuditChain {
    /// Create a new [`AuditChain`] with the given `capacity`.
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(1);
        Self {
            entries: VecDeque::with_capacity(cap),
            head_prev_hash: "0".repeat(64),
            capacity: cap,
            next_seq: 1,
        }
    }

    /// Append a user-initiated audit entry at `at_ms`.
    pub fn append(
        &mut self,
        at_ms: u64,
        op: &str,
        subject: &str,
        resource: &str,
        outcome: &str,
        note: &str,
    ) -> &AuditEntry {
        self.append_as("user", at_ms, op, subject, resource, outcome, note)
    }

    /// Append an audit entry with an explicit `actor` class (`"user"` or `"machine"`).
    pub fn append_as(
        &mut self,
        actor: &str,
        at_ms: u64,
        op: &str,
        subject: &str,
        resource: &str,
        outcome: &str,
        note: &str,
    ) -> &AuditEntry {
        let seq = self.next_seq;
        self.next_seq += 1;

        let mut entry = AuditEntry {
            seq,
            at_ms,
            op: op.to_string(),
            subject: subject.to_string(),
            resource: resource.to_string(),
            outcome: outcome.to_string(),
            actor: actor.to_string(),
            note: note.to_string(),
            hash: String::new(),
        };

        let prev_hash = self
            .entries
            .back()
            .map_or_else(|| self.head_prev_hash.clone(), |e| e.hash.clone());
        entry.hash = compute_audit_hash(&prev_hash, &entry);

        if self.entries.len() >= self.capacity {
            if let Some(dropped) = self.entries.pop_front() {
                self.head_prev_hash = dropped.hash;
            }
        }
        self.entries.push_back(entry);
        // Safe because we just pushed to `self.entries`
        #[allow(clippy::expect_used)]
        self.entries.back().expect("just pushed entry")
    }

    /// Verify the cryptographic hash chain from `head_prev_hash` through all retained entries.
    ///
    /// # Errors
    ///
    /// Returns `Err((seq, expected_hash, actual_hash))` at the first tampered entry.
    pub fn verify(&self) -> Result<(), (u64, String, String)> {
        let mut prev = self.head_prev_hash.clone();
        for e in &self.entries {
            let expected = compute_audit_hash(&prev, e);
            if expected != e.hash {
                return Err((e.seq, expected, e.hash.clone()));
            }
            prev = e.hash.clone();
        }
        Ok(())
    }
}

// ============================================================================
// 4. Bounded Slow-Query Ring Buffer (xerj-engine/src/slow_query.rs)
// ============================================================================

/// Default slow-query threshold in milliseconds (`1000` ms).
pub const DEFAULT_SLOW_QUERY_MS: u64 = 1_000;

/// Default slow-query ring buffer capacity (`256`).
pub const DEFAULT_SLOW_QUERY_CAPACITY: usize = 256;

/// Maximum bytes of query body retained per slow-query entry (`2048`).
pub const SLOW_QUERY_MAX_BODY: usize = 2_048;

/// Truncate a query body to [`SLOW_QUERY_MAX_BODY`] bytes on a UTF-8 char boundary,
/// appending `'…'` when clipped.
#[must_use]
pub fn truncate_query_body(s: &str) -> String {
    if s.len() <= SLOW_QUERY_MAX_BODY {
        return s.to_string();
    }
    let mut end = SLOW_QUERY_MAX_BODY;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Structured entry in the slow-query ring buffer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlowQueryEntry {
    /// Wall-clock timestamp in milliseconds since Unix epoch.
    pub at_ms: u64,
    /// Target index or Linear surface name.
    pub index: String,
    /// Operation route (e.g. `"search"`, `"graphql.issues"`).
    pub op: String,
    /// Total duration in milliseconds.
    pub took_ms: u64,
    /// Number of hits returned.
    pub hits: u64,
    /// Optional diagnostic note.
    pub note: String,
    /// Truncated query body (`<= SLOW_QUERY_MAX_BODY` bytes).
    pub query: String,
}

/// Bounded ring buffer of slow queries exceeding `threshold_ms`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlowQueryBuffer {
    /// Retained slow-query entries.
    pub entries: VecDeque<SlowQueryEntry>,
    /// Maximum capacity.
    pub capacity: usize,
    /// Threshold in milliseconds at or above which queries are recorded.
    pub threshold_ms: u64,
    /// Total slow queries observed since initialization.
    pub total_slow: u64,
}

impl SlowQueryBuffer {
    /// Construct a new [`SlowQueryBuffer`] with `capacity` and `threshold_ms`.
    #[must_use]
    pub fn new(capacity: usize, threshold_ms: u64) -> Self {
        let cap = capacity.max(1);
        Self {
            entries: VecDeque::with_capacity(cap),
            capacity: cap,
            threshold_ms,
            total_slow: 0,
        }
    }

    /// Record a query if `took_ms >= self.threshold_ms`. Returns `true` if recorded.
    pub fn maybe_record(
        &mut self,
        at_ms: u64,
        index: &str,
        op: &str,
        took_ms: u64,
        hits: u64,
        note: &str,
        query: &str,
    ) -> bool {
        if took_ms < self.threshold_ms {
            return false;
        }
        self.total_slow += 1;
        let entry = SlowQueryEntry {
            at_ms,
            index: index.to_string(),
            op: op.to_string(),
            took_ms,
            hits,
            note: note.to_string(),
            query: truncate_query_body(query),
        };
        if self.entries.len() >= self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
        true
    }
}

// ============================================================================
// 5. Editorial Frontmatter & 12-Rule Link-Safety Denylist Checker (science/src/site_check.rs)
// ============================================================================

/// Allowed editorial frontmatter `type` values.
pub const ALLOWED_TYPES: &[&str] = &[
    "start",
    "status",
    "finding",
    "guide",
    "design-summary",
    "records-index",
    "overview",
];

/// Allowed editorial frontmatter `status` values.
pub const ALLOWED_STATUSES: &[&str] = &["draft", "reviewed", "approved", "superseded"];

/// All recognized editorial frontmatter keys.
pub const ALLOWED_KEYS: &[&str] = &[
    "type",
    "status",
    "owner",
    "approved_by",
    "last_reviewed",
    "sources",
    "superseded_by",
];

/// Required editorial frontmatter keys.
pub const REQUIRED_KEYS: &[&str] = &[
    "type",
    "status",
    "owner",
    "approved_by",
    "last_reviewed",
    "sources",
];

/// Parsed subset of `gitbook-docs.yaml`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitBookConfig {
    /// Content root relative to repository root (defaults to `"."`).
    pub structure_root: String,
    /// Summary file relative to content root (defaults to `"SUMMARY.md"`).
    pub structure_summary: String,
    /// Map of redirect source path to target path.
    pub redirects: BTreeMap<String, String>,
}

/// Parsed YAML frontmatter for an editorial markdown file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedFrontmatter {
    /// Raw scalar values keyed by field name.
    pub scalars: BTreeMap<String, String>,
    /// List values keyed by field name (e.g., `sources`).
    pub lists: BTreeMap<String, Vec<String>>,
    /// All keys seen in the frontmatter block in order.
    pub keys_present: Vec<String>,
}

/// Pure byte-slice 7-bit ASCII validator returning `ERROR: {rel}:{line}: non-ASCII byte ...`.
#[must_use]
pub fn check_ascii_bytes(raw: &[u8], rel: &str) -> Vec<String> {
    let mut errors = Vec::new();
    for (idx, line) in raw.split(|&b| b == b'\n').enumerate() {
        let line_no = idx + 1;
        for &byte in line {
            if byte > 0x7f {
                errors.push(format!(
                    "ERROR: {rel}:{line_no}: non-ASCII byte 0x{byte:02x}"
                ));
                break;
            }
        }
    }
    errors
}

/// Pure string validator checking all 12 link-safety denylist rules per line:
/// `tailnet-host`, `secret-reference`, `private-ip-10`, `private-ip-192`, `private-ip-172`,
/// `tailnet-ip-100`, `work-email`, `slack-id`, `word-handoff`, `word-1password`,
/// `word-session-note`, and `word-session-dash-note`.
#[must_use]
pub fn check_denylist_str(text: &str, rel: &str) -> Vec<String> {
    let mut errors = Vec::new();
    for (idx, line) in text.split('\n').enumerate() {
        let line_no = idx + 1;
        let lower = line.to_ascii_lowercase();

        if contains_word_bounded_ci(&lower, "ts.net") {
            errors.push(format!(
                "ERROR: {rel}:{line_no}: link-safety pattern tailnet-host"
            ));
        }
        if lower.contains("op://") {
            errors.push(format!(
                "ERROR: {rel}:{line_no}: link-safety pattern secret-reference"
            ));
        }
        if has_ipv4_with_prefix(line, |a, _b| a == 10) {
            errors.push(format!(
                "ERROR: {rel}:{line_no}: link-safety pattern private-ip-10"
            ));
        }
        if has_ipv4_with_prefix(line, |a, b| a == 192 && b == 168) {
            errors.push(format!(
                "ERROR: {rel}:{line_no}: link-safety pattern private-ip-192"
            ));
        }
        if has_ipv4_with_prefix(line, |a, b| a == 172 && (16..=31).contains(&b)) {
            errors.push(format!(
                "ERROR: {rel}:{line_no}: link-safety pattern private-ip-172"
            ));
        }
        if has_ipv4_with_prefix(line, |a, b| a == 100 && (64..=127).contains(&b)) {
            errors.push(format!(
                "ERROR: {rel}:{line_no}: link-safety pattern tailnet-ip-100"
            ));
        }
        if contains_work_email(&lower) {
            errors.push(format!(
                "ERROR: {rel}:{line_no}: link-safety pattern work-email"
            ));
        }
        if contains_slack_id(line) {
            errors.push(format!(
                "ERROR: {rel}:{line_no}: link-safety pattern slack-id"
            ));
        }
        if contains_word_bounded_ci(&lower, "handoff") {
            errors.push(format!(
                "ERROR: {rel}:{line_no}: link-safety pattern word-handoff"
            ));
        }
        if contains_word_bounded_ci(&lower, "1password") {
            errors.push(format!(
                "ERROR: {rel}:{line_no}: link-safety pattern word-1password"
            ));
        }
        if contains_word_bounded_ci(&lower, "session note") {
            errors.push(format!(
                "ERROR: {rel}:{line_no}: link-safety pattern word-session-note"
            ));
        }
        if contains_word_bounded_ci(&lower, "session-note") {
            errors.push(format!(
                "ERROR: {rel}:{line_no}: link-safety pattern word-session-dash-note"
            ));
        }
    }
    errors
}

/// Pure string YAML frontmatter parser and editorial schema validator.
#[must_use]
pub fn check_frontmatter_str(text: &str, rel: &str) -> (Option<ParsedFrontmatter>, Vec<String>) {
    let mut errors = Vec::new();
    let Some(rest) = text.strip_prefix("---\n") else {
        errors.push(format!("ERROR: {rel}:1: missing YAML frontmatter block"));
        return (None, errors);
    };

    let (block, body) = if let Some(end_idx) = rest.find("\n---\n") {
        (&rest[..end_idx], &rest[end_idx + 5..])
    } else if let Some(stripped) = rest.strip_suffix("\n---") {
        (stripped, "")
    } else {
        errors.push(format!("ERROR: {rel}:1: unclosed YAML frontmatter block"));
        return (None, errors);
    };

    let fm = match parse_frontmatter_block(block) {
        Ok(fm) => fm,
        Err(e) => {
            errors.push(format!("ERROR: {rel}:1: invalid YAML frontmatter: {e}"));
            return (None, errors);
        }
    };

    for k in &fm.keys_present {
        if !ALLOWED_KEYS.contains(&k.as_str()) {
            errors.push(format!("ERROR: {rel}: unknown frontmatter key '{k}'"));
        }
    }

    for &req in REQUIRED_KEYS {
        if !fm.keys_present.iter().any(|k| k == req) {
            errors.push(format!("ERROR: {rel}: missing frontmatter key '{req}'"));
        }
    }

    if let Some(t) = fm.scalars.get("type") {
        if !ALLOWED_TYPES.contains(&t.as_str()) {
            errors.push(format!("ERROR: {rel}: invalid type '{t}'"));
        }
    }

    if let Some(s) = fm.scalars.get("status") {
        if !ALLOWED_STATUSES.contains(&s.as_str()) {
            errors.push(format!("ERROR: {rel}: invalid status '{s}'"));
        }
    }

    if fm.keys_present.iter().any(|k| k == "owner") {
        let owner = fm.scalars.get("owner").map_or("", |s| s.trim());
        if owner.is_empty() {
            errors.push(format!("ERROR: {rel}: owner must be a non-empty string"));
        }
    }

    if fm.keys_present.iter().any(|k| k == "approved_by") {
        let approved = fm.scalars.get("approved_by").map_or("", |s| s.trim());
        if approved.is_empty() {
            errors.push(format!(
                "ERROR: {rel}: approved_by must be a non-empty string"
            ));
        }
    }

    if let Some(lr) = fm.scalars.get("last_reviewed") {
        if !is_valid_date(lr) {
            errors.push(format!(
                "ERROR: {rel}: last_reviewed '{lr}' is not YYYY-MM-DD"
            ));
        }
    }

    if fm.keys_present.iter().any(|k| k == "sources") {
        match fm.lists.get("sources") {
            Some(items) if !items.is_empty() => {
                for item in items {
                    if !is_valid_source_ref(item) {
                        errors.push(format!(
                            "ERROR: {rel}: source '{item}' does not match an allowed format"
                        ));
                    }
                }
            }
            _ => {
                errors.push(format!("ERROR: {rel}: sources must be a non-empty list"));
            }
        }
    }

    if body.trim().is_empty() {
        errors.push(format!("ERROR: {rel}: page has no body after frontmatter"));
    }

    (Some(fm), errors)
}

/// Parse `gitbook-docs.yaml` from a string slice.
///
/// # Errors
///
/// Returns an error string if a line is malformed.
pub fn parse_gitbook_config_str(raw: &str) -> Result<GitBookConfig, String> {
    let mut cfg = GitBookConfig {
        structure_root: ".".to_string(),
        structure_summary: "SUMMARY.md".to_string(),
        redirects: BTreeMap::new(),
    };

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Section {
        Top,
        Structure,
        Redirects,
    }

    let mut section = Section::Top;
    for raw_line in raw.lines() {
        let line_no_comment = strip_yaml_comment(raw_line);
        if line_no_comment.trim().is_empty() {
            continue;
        }
        let indent = line_no_comment.len() - line_no_comment.trim_start().len();
        let trimmed = line_no_comment.trim();
        let Some((key, val)) = trimmed.split_once(':') else {
            return Err(format!("expected key: value, got '{trimmed}'"));
        };
        let key = unquote_yaml(key.trim());
        let val = unquote_yaml(val.trim());

        if indent == 0 {
            match key.as_str() {
                "root" => {
                    if !val.is_empty() {
                        cfg.structure_root = val;
                    }
                    section = Section::Top;
                }
                "structure" => {
                    section = Section::Structure;
                }
                "redirects" => {
                    section = Section::Redirects;
                }
                _ => {
                    section = Section::Top;
                }
            }
        } else {
            match section {
                Section::Structure => {
                    if key == "summary" && !val.is_empty() {
                        cfg.structure_summary = val;
                    }
                }
                Section::Redirects => {
                    if !key.is_empty() && !val.is_empty() && val != "{}" {
                        cfg.redirects.insert(key, val);
                    }
                }
                Section::Top => {}
            }
        }
    }

    Ok(cfg)
}

fn parse_frontmatter_block(block: &str) -> Result<ParsedFrontmatter, String> {
    let mut fm = ParsedFrontmatter::default();
    let mut current_list_key: Option<String> = None;

    for raw_line in block.split('\n') {
        let line = strip_yaml_comment(raw_line);
        if line.trim().is_empty() {
            continue;
        }
        let trimmed_start = line.trim_start();
        if let Some(item_rest) = trimmed_start.strip_prefix('-') {
            if item_rest.is_empty() || item_rest.starts_with(char::is_whitespace) {
                let Some(ref list_key) = current_list_key else {
                    return Err(format!("unexpected list item '{trimmed_start}'"));
                };
                let item_val = unquote_yaml(item_rest.trim());
                fm.lists.entry(list_key.clone()).or_default().push(item_val);
                continue;
            }
        }

        let Some((raw_k, raw_v)) = line.split_once(':') else {
            return Err(format!("malformed frontmatter line '{line}'"));
        };
        let key = raw_k.trim().to_string();
        let val_trimmed = raw_v.trim();
        if !fm.keys_present.contains(&key) {
            fm.keys_present.push(key.clone());
        }

        if val_trimmed.is_empty() {
            current_list_key = Some(key);
        } else if val_trimmed.starts_with('[') && val_trimmed.ends_with(']') {
            current_list_key = None;
            let inner = &val_trimmed[1..val_trimmed.len() - 1];
            let items: Vec<String> = inner
                .split(',')
                .map(|s| unquote_yaml(s.trim()))
                .filter(|s| !s.is_empty())
                .collect();
            fm.lists.insert(key, items);
        } else {
            current_list_key = None;
            let unquoted = unquote_yaml(val_trimmed);
            if !unquoted.is_empty() && unquoted != "null" && unquoted != "~" {
                fm.scalars.insert(key, unquoted);
            }
        }
    }

    Ok(fm)
}

fn strip_yaml_comment(line: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;
    let bytes = line.as_bytes();
    for i in 0..bytes.len() {
        match bytes[i] {
            b'\'' if !in_double => in_single = !in_single,
            b'"' if !in_single => in_double = !in_double,
            b'#' if !in_single && !in_double && (i == 0 || bytes[i - 1].is_ascii_whitespace()) => {
                return &line[..i];
            }
            _ => {}
        }
    }
    line
}

fn unquote_yaml(s: &str) -> String {
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')))
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn contains_word_bounded_ci(haystack_lower: &str, needle_lower: &str) -> bool {
    let h = haystack_lower.as_bytes();
    let n = needle_lower.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return false;
    }
    for start in 0..=(h.len() - n.len()) {
        if &h[start..start + n.len()] == n {
            let left_ok = start == 0 || !is_word_byte(h[start - 1]);
            let right_idx = start + n.len();
            let right_ok = right_idx == h.len() || !is_word_byte(h[right_idx]);
            if left_ok && right_ok {
                return true;
            }
        }
    }
    false
}

fn contains_work_email(haystack_lower: &str) -> bool {
    let domain = "@cerebral.work";
    let h = haystack_lower.as_bytes();
    let d = domain.as_bytes();
    if h.len() <= d.len() {
        return false;
    }
    for idx in 1..=(h.len() - d.len()) {
        if &h[idx..idx + d.len()] == d {
            let prev = h[idx - 1];
            let local_ok =
                prev.is_ascii_alphanumeric() || matches!(prev, b'.' | b'_' | b'%' | b'+' | b'-');
            let right_idx = idx + d.len();
            let right_ok = right_idx == h.len() || !is_word_byte(h[right_idx]);
            if local_ok && right_ok {
                return true;
            }
        }
    }
    false
}

fn contains_slack_id(line: &str) -> bool {
    let bytes = line.as_bytes();
    if bytes.len() < 10 {
        return false;
    }
    let mut i = 0;
    while i + 10 <= bytes.len() {
        if bytes[i] == b'U' && bytes[i + 1] == b'0' {
            let left_ok = i == 0 || !is_word_byte(bytes[i - 1]);
            if left_ok {
                let mut j = i + 2;
                while j < bytes.len()
                    && (bytes[j].is_ascii_uppercase() || bytes[j].is_ascii_digit())
                {
                    j += 1;
                }
                let run_len = j - (i + 2);
                let right_ok = j == bytes.len() || !is_word_byte(bytes[j]);
                if run_len >= 8 && right_ok {
                    return true;
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
    false
}

fn has_ipv4_with_prefix<F>(line: &str, pred: F) -> bool
where
    F: Fn(u16, u16) -> bool,
{
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() && (i == 0 || !is_word_byte(bytes[i - 1])) {
            if let Some((octets, end_idx)) = parse_ipv4_at(bytes, i) {
                let right_ok = end_idx == bytes.len() || !is_word_byte(bytes[end_idx]);
                if right_ok && pred(octets[0], octets[1]) {
                    return true;
                }
                i = end_idx;
                continue;
            }
        }
        i += 1;
    }
    false
}

fn parse_ipv4_at(bytes: &[u8], start: usize) -> Option<([u16; 4], usize)> {
    let mut idx = start;
    let mut octets = [0_u16; 4];
    for (part, slot) in octets.iter_mut().enumerate() {
        if part > 0 {
            if idx >= bytes.len() || bytes[idx] != b'.' {
                return None;
            }
            idx += 1;
        }
        let digit_start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() && (idx - digit_start) < 4 {
            idx += 1;
        }
        let digit_len = idx - digit_start;
        if !(1..=3).contains(&digit_len) {
            return None;
        }
        let s = std::str::from_utf8(&bytes[digit_start..idx]).ok()?;
        *slot = s.parse::<u16>().ok()?;
    }
    Some((octets, idx))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resource_governor_trips_and_recovers_with_hysteresis() {
        let cfg = ResourceGovernorConfig::default();
        let mut gov = ResourceGovernorState::from_config(&cfg);
        assert!(gov.check_ingest_admission().is_admitted());

        // Trip RSS and disk flood-stage (95%)
        gov.refresh(0, gov.memory_watermark_bytes + 1, 95);
        assert!(!gov.check_ingest_admission().is_admitted());
        assert!(!gov.check_disk_block("issues").is_admitted());

        // Disk hysteresis: 94% stays blocked; 93% releases
        gov.refresh(0, 100, 94);
        assert!(!gov.check_disk_block("issues").is_admitted());
        gov.refresh(0, 100, 93);
        assert!(gov.check_disk_block("issues").is_admitted());
    }

    #[test]
    fn rbac_role_descriptors_and_worm_audit_chain_verify() {
        let roles = roles_from_role_descriptors(&json!({
            "alice-brain": {
                "cluster": ["read_audit"],
                "indices": [
                    { "names": [".xerj-memory-alice*"], "privileges": ["read", "write"] }
                ]
            }
        }));
        assert_eq!(roles.len(), 2);
        assert!(roles
            .iter()
            .any(|r| r.allows(".xerj-memory-alice-edges", Privilege::WriteIndex)));

        let mut chain = AuditChain::new(2);
        for i in 0..5 {
            chain.append(1000 + i, "search", "alice", "issues", "ok", "");
        }
        assert_eq!(chain.entries.len(), 2);
        assert!(chain.verify().is_ok());

        chain.entries[0].subject = "mallory".to_string();
        assert!(chain.verify().is_err());
    }

    #[test]
    fn slow_query_buffer_and_all_twelve_denylist_rules_work() {
        let mut sq = SlowQueryBuffer::new(2, 100);
        assert!(!sq.maybe_record(1, "idx", "search", 50, 1, "", "q"));
        assert!(sq.maybe_record(2, "idx", "search", 150, 1, "", "q"));
        assert_eq!(sq.total_slow, 1);

        let cases = [
            ("host foo.ts.net here\n", "tailnet-host"),
            ("ref op://vault/item/field\n", "secret-reference"),
            ("ip 10.20.30.40\n", "private-ip-10"),
            ("ip 192.168.1.1\n", "private-ip-192"),
            ("ip 172.20.0.1\n", "private-ip-172"),
            ("ip 100.80.1.2\n", "tailnet-ip-100"),
            ("mail user@cerebral.work\n", "work-email"),
            ("id U0ABCDEF123\n", "slack-id"),
            ("see the handoff file\n", "word-handoff"),
            ("stored in 1Password\n", "word-1password"),
            ("from the session note yesterday\n", "word-session-note"),
            (
                "from the session-note yesterday\n",
                "word-session-dash-note",
            ),
        ];
        for (line, expected) in cases {
            let errs = check_denylist_str(line, "overview/a.md");
            assert!(
                errs.iter().any(|e| e.contains(expected)),
                "expected {expected} for {line}"
            );
        }
    }
}
