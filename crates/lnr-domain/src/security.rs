//! Agent security containment, capability attenuation, MCP protocol anomaly inspection,
//! reversibility governance, and watchdog state transitions borrowed from `researchd`
//! (`science/src/security.rs`).

use serde::{Deserialize, Serialize};

use crate::error::DomainError;

/// Sensitive path prefixes and directory names that an agent capability envelope
/// or workspace tool may never grant or traverse.
pub const PROHIBITED_SENSITIVE_PATHS: &[&str] =
    &["/proc", "/sys", ".ssh", ".gnupg", ".env", ".git/hooks"];

/// Canonical MCP JSON-RPC method names allowed as distinct metric labels.
pub const KNOWN_MCP_METHODS: &[&str] = &[
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
    "tools/call",
    "resources/list",
    "resources/read",
    "resources/templates/list",
    "resources/subscribe",
    "prompts/list",
    "prompts/get",
    "logging/setLevel",
    "completion/complete",
    "roots/list",
];

/// Fallback metric label used when an inbound JSON-RPC method is unrecognized
/// or exceeds [`MAX_TELEMETRY_METHOD_BYTES`].
pub const UNKNOWN_MCP_METHOD_BUCKET: &str = "unknown_method";

/// Maximum byte length permitted for an inbound protocol method name before bucketing.
pub const MAX_TELEMETRY_METHOD_BYTES: usize = 256;

/// Ordered access rights for capability path grants (`ReadOnly < ReadWrite < Execute`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessRight {
    /// Read-only access to the granted path subtree.
    ReadOnly,
    /// Read and write access to the granted path subtree.
    ReadWrite,
    /// Read, write, and executable access to the granted path subtree.
    Execute,
}

impl AccessRight {
    /// Return `true` if `self` encompasses `requested` without privilege escalation.
    #[must_use]
    pub const fn allows(self, requested: Self) -> bool {
        matches!(
            (self, requested),
            (Self::Execute, _)
                | (Self::ReadWrite, Self::ReadWrite | Self::ReadOnly)
                | (Self::ReadOnly, Self::ReadOnly)
        )
    }
}

/// A normalized path prefix paired with an [`AccessRight`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathGrant {
    /// Normalized path prefix.
    pub prefix: String,
    /// Maximum access right granted under `prefix`.
    pub right: AccessRight,
}

impl PathGrant {
    /// Construct and validate a [`PathGrant`], rejecting traversal sequences and prohibited paths.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::SecurityViolation`] if the path is empty, contains `..`, or hits [`PROHIBITED_SENSITIVE_PATHS`].
    pub fn new(prefix: impl Into<String>, right: AccessRight) -> Result<Self, DomainError> {
        let raw = prefix.into();
        let normalized = normalize_and_check_prohibited_path(&raw)?;
        Ok(Self {
            prefix: normalized,
            right,
        })
    }

    /// Return `true` if this grant covers `child_prefix` with at least `child_right`.
    #[must_use]
    pub fn covers(&self, child_prefix: &str, child_right: AccessRight) -> bool {
        if !self.right.allows(child_right) {
            return false;
        }
        path_prefix_covers(&self.prefix, child_prefix)
    }
}

/// Lifecycle state of a [`CapabilityEnvelope`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeState {
    /// Freshly minted root capability envelope.
    Minted,
    /// Attenuated child capability envelope derived from a parent envelope.
    Attenuated,
    /// Immutable sealed envelope ready for runtime enforcement.
    Sealed,
}

/// Monotonically attenuating capability envelope governing path, network, memory, and process limits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityEnvelope {
    /// Unique identifier for the envelope.
    pub id: String,
    /// Lifecycle state (`Minted`, `Attenuated`, or `Sealed`).
    pub state: EnvelopeState,
    /// Validated path grants.
    pub path_grants: Vec<PathGrant>,
    /// Whether outbound network requests are permitted.
    pub allow_network: bool,
    /// Maximum resident memory budget in bytes (`> 0`).
    pub max_memory_bytes: u64,
    /// Maximum concurrent process/thread count (`> 0`).
    pub max_pids: u32,
}

impl CapabilityEnvelope {
    /// Mint a new root capability envelope after validating all path grants and resource bounds.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::SecurityViolation`] if any bound is zero or any grant is prohibited.
    pub fn mint(
        id: impl Into<String>,
        path_grants: Vec<PathGrant>,
        allow_network: bool,
        max_memory_bytes: u64,
        max_pids: u32,
    ) -> Result<Self, DomainError> {
        let id_str = id.into();
        if id_str.trim().is_empty() {
            return Err(DomainError::SecurityViolation(
                "capability envelope id must not be empty".to_string(),
            ));
        }
        if max_memory_bytes == 0 || max_pids == 0 {
            return Err(DomainError::SecurityViolation(
                "memory and pid limits must be greater than zero".to_string(),
            ));
        }
        for grant in &path_grants {
            normalize_and_check_prohibited_path(&grant.prefix)?;
        }
        Ok(Self {
            id: id_str,
            state: EnvelopeState::Minted,
            path_grants,
            allow_network,
            max_memory_bytes,
            max_pids,
        })
    }

    /// Derive a strictly attenuated child envelope.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::SecurityViolation`] if `self` is sealed or if any requested resource escalates privileges.
    pub fn attenuate(
        &self,
        child_id: impl Into<String>,
        requested_grants: Vec<PathGrant>,
        allow_network: bool,
        max_memory_bytes: u64,
        max_pids: u32,
    ) -> Result<Self, DomainError> {
        if self.state == EnvelopeState::Sealed {
            return Err(DomainError::SecurityViolation(
                "cannot attenuate an already sealed capability envelope".to_string(),
            ));
        }
        let child_id_str = child_id.into();
        if child_id_str.trim().is_empty() {
            return Err(DomainError::SecurityViolation(
                "child capability envelope id must not be empty".to_string(),
            ));
        }
        if allow_network && !self.allow_network {
            return Err(DomainError::SecurityViolation(
                "privilege escalation denied: parent envelope forbids network access".to_string(),
            ));
        }
        if max_memory_bytes == 0 || max_memory_bytes > self.max_memory_bytes {
            return Err(DomainError::SecurityViolation(
                "privilege escalation denied: requested memory exceeds parent ceiling".to_string(),
            ));
        }
        if max_pids == 0 || max_pids > self.max_pids {
            return Err(DomainError::SecurityViolation(
                "privilege escalation denied: requested max_pids exceeds parent ceiling"
                    .to_string(),
            ));
        }
        for req in &requested_grants {
            normalize_and_check_prohibited_path(&req.prefix)?;
            let covered = self
                .path_grants
                .iter()
                .any(|parent| parent.covers(&req.prefix, req.right));
            if !covered {
                return Err(DomainError::SecurityViolation(format!(
                    "privilege escalation denied: path grant '{}' is not covered by parent",
                    req.prefix
                )));
            }
        }
        Ok(Self {
            id: child_id_str,
            state: EnvelopeState::Attenuated,
            path_grants: requested_grants,
            allow_network,
            max_memory_bytes,
            max_pids,
        })
    }

    /// Seal the envelope so no further mutation or attenuation can occur.
    #[must_use]
    pub fn seal(mut self) -> Self {
        self.state = EnvelopeState::Sealed;
        self
    }
}

fn normalize_and_check_prohibited_path(raw: &str) -> Result<String, DomainError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(DomainError::SecurityViolation(
            "path must not be empty".to_string(),
        ));
    }
    if trimmed.contains('\0') {
        return Err(DomainError::SecurityViolation(
            "path contains null byte".to_string(),
        ));
    }
    for seg in trimmed.split(['/', '\\']) {
        if seg == ".." {
            return Err(DomainError::SecurityViolation(format!(
                "path traversal '..' rejected in '{trimmed}'"
            )));
        }
    }
    for &prohibited in PROHIBITED_SENSITIVE_PATHS {
        if trimmed == prohibited
            || trimmed.starts_with(&format!("{prohibited}/"))
            || trimmed.ends_with(&format!("/{prohibited}"))
            || trimmed.contains(&format!("/{prohibited}/"))
        {
            return Err(DomainError::SecurityViolation(format!(
                "prohibited sensitive path '{prohibited}' in '{trimmed}'"
            )));
        }
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

fn path_prefix_covers(parent: &str, child: &str) -> bool {
    let p = parent.trim_end_matches('/');
    let c = child.trim_end_matches('/');
    if p == c {
        return true;
    }
    c.starts_with(p) && c.as_bytes().get(p.len()) == Some(&b'/')
}

/// Sanitize an inbound JSON-RPC / MCP method name to prevent metric cardinality explosion.
#[must_use]
pub fn sanitize_telemetry_method(method: &str) -> &'static str {
    let trimmed = method.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_TELEMETRY_METHOD_BYTES {
        return UNKNOWN_MCP_METHOD_BUCKET;
    }
    for &known in KNOWN_MCP_METHODS {
        if trimmed == known {
            return known;
        }
    }
    UNKNOWN_MCP_METHOD_BUCKET
}

/// Anomaly flags raised when inspecting an inbound protocol payload (`mcp-honeypot`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolAnomalyFlag {
    /// Hidden Unicode bidirectional override or zero-width joiner character detected.
    HiddenUnicodeBidiOrZeroWidth,
    /// Raw ANSI terminal escape sequence (`\x1b[`) detected.
    AnsiEscapeSequence,
    /// Relative path traversal (`../` or `..\`) detected.
    PathTraversalSequence,
    /// Reference to a prohibited sensitive path (`/proc`, `.ssh`, `.env`, etc.) detected.
    SensitivePathProbe,
}

/// Result of inspecting an inbound protocol payload for injection and traversal anomalies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolInspection {
    /// Sanitized telemetry method bucket.
    pub telemetry_method: String,
    /// True if no anomaly flags were triggered.
    pub clean: bool,
    /// Ordered list of detected anomaly flags.
    pub flags: Vec<ProtocolAnomalyFlag>,
}

/// Inspect a protocol method and payload body for hidden Unicode, ANSI escapes, and path probes.
#[must_use]
pub fn inspect_protocol_payload(method: &str, payload: &str) -> ProtocolInspection {
    let telemetry_method = sanitize_telemetry_method(method).to_string();
    let mut flags = Vec::new();

    if payload.chars().any(|c| {
        matches!(
            c as u32,
            0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2069 | 0xFEFF
        )
    }) {
        flags.push(ProtocolAnomalyFlag::HiddenUnicodeBidiOrZeroWidth);
    }

    if payload.contains("\x1b[") || payload.contains("\u{009b}") {
        flags.push(ProtocolAnomalyFlag::AnsiEscapeSequence);
    }

    if payload.contains("../") || payload.contains("..\\") {
        flags.push(ProtocolAnomalyFlag::PathTraversalSequence);
    }

    if PROHIBITED_SENSITIVE_PATHS
        .iter()
        .any(|p| payload.contains(p))
    {
        flags.push(ProtocolAnomalyFlag::SensitivePathProbe);
    }

    ProtocolInspection {
        telemetry_method,
        clean: flags.is_empty(),
        flags,
    }
}

/// Constant-time byte comparison for bearer tokens and webhook signatures.
#[must_use]
pub fn constant_time_secret_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Action reversibility classification (`R0..R3` from `wheelhorsedev/nexus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReversibilityClass {
    /// `R0`: Read-only or side-effect-free query.
    R0ReadOnly,
    /// `R1`: Automatically reversible local or staging state transition.
    R1AutoReversible,
    /// `R2`: Reversible with compensating action (`ReversalPlan` required).
    R2Compensatable,
    /// `R3`: Irreversible external mutation (requires explicit operator approval).
    R3Irreversible,
}

/// Compensating reversal plan attached to `R1`/`R2` mutations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReversalPlan {
    /// Description of how to undo the mutation.
    pub description: String,
    /// Command or API operation that performs the compensation.
    pub compensating_command: String,
}

/// Governance decision returned for a classified mutation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GovernanceDecision {
    /// Execute autonomously.
    AllowAutonomous,
    /// Require explicit human operator approval before executing.
    RequireOperatorApproval,
    /// Deny immediately (missing required reversal plan or tripwire triggered).
    Deny,
}

/// Evaluate whether an action of `class` may execute autonomously, requires operator approval, or is denied.
#[must_use]
pub fn evaluate_reversibility_governance(
    class: ReversibilityClass,
    reversal_plan: Option<&ReversalPlan>,
    operator_approved: bool,
    tripwire_triggered: bool,
) -> GovernanceDecision {
    if tripwire_triggered {
        return GovernanceDecision::Deny;
    }
    match class {
        ReversibilityClass::R0ReadOnly | ReversibilityClass::R1AutoReversible => {
            GovernanceDecision::AllowAutonomous
        }
        ReversibilityClass::R2Compensatable => match reversal_plan {
            Some(plan)
                if !plan.description.trim().is_empty()
                    && !plan.compensating_command.trim().is_empty() =>
            {
                GovernanceDecision::AllowAutonomous
            }
            _ => GovernanceDecision::Deny,
        },
        ReversibilityClass::R3Irreversible => {
            if operator_approved {
                GovernanceDecision::AllowAutonomous
            } else {
                GovernanceDecision::RequireOperatorApproval
            }
        }
    }
}

/// Watchdog health state (`todie/kerberos` silent-failure folding).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchdogHealth {
    /// Healthy heartbeat within freshness threshold.
    Green,
    /// Degraded or approaching threshold.
    Yellow,
    /// Missing, stale, or failed heartbeat (fail-closed).
    Red,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn capability_envelope_enforces_monotonic_attenuation() {
        let root_grant = PathGrant::new("crates/lnr-domain", AccessRight::ReadWrite).unwrap();
        let root =
            CapabilityEnvelope::mint("root", vec![root_grant], true, 1024 * 1024, 4).unwrap();

        let child_grant = PathGrant::new("crates/lnr-domain/src", AccessRight::ReadOnly).unwrap();
        let child = root
            .attenuate("child", vec![child_grant], false, 512 * 1024, 2)
            .unwrap()
            .seal();
        assert_eq!(child.state, EnvelopeState::Sealed);

        assert!(PathGrant::new("/proc/self", AccessRight::ReadOnly).is_err());
        assert!(PathGrant::new("crates/../../etc/passwd", AccessRight::ReadOnly).is_err());
    }

    #[test]
    fn protocol_inspection_catches_bidi_and_traversal() {
        let clean = inspect_protocol_payload("tools/call", r#"{"name":"whoami"}"#);
        assert!(clean.clean);
        assert_eq!(clean.telemetry_method, "tools/call");

        let bad = inspect_protocol_payload("evil_method", "hello \u{202E} ../../.ssh/id_ed25519");
        assert!(!bad.clean);
        assert_eq!(bad.telemetry_method, UNKNOWN_MCP_METHOD_BUCKET);
        assert!(bad
            .flags
            .contains(&ProtocolAnomalyFlag::HiddenUnicodeBidiOrZeroWidth));
        assert!(bad
            .flags
            .contains(&ProtocolAnomalyFlag::PathTraversalSequence));
        assert!(bad.flags.contains(&ProtocolAnomalyFlag::SensitivePathProbe));
    }
}
