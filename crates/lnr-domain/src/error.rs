//! Typed domain and CLI errors for `lnr`.

use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Failures returned by [`crate::Item`], [`crate::ItemId`], and [`crate::ItemRepository`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DomainError {
    /// An [`crate::ItemId`] violated the identifier syntax rules.
    #[error("invalid item id {id:?}: {reason}")]
    InvalidId {
        /// The rejected identifier text.
        id: String,
        /// Why it was rejected.
        reason: &'static str,
    },

    /// A state transition is not valid from the item's current state.
    #[error("illegal transition from {from:?} to {to:?}")]
    IllegalTransition {
        /// Current state.
        from: crate::item::ItemState,
        /// Target state.
        to: crate::item::ItemState,
    },

    /// The repository already holds an item with this id.
    #[error("item {0} already exists")]
    Duplicate(String),

    /// No item with this id exists in the repository.
    #[error("item {0} not found")]
    NotFound(String),

    /// Invalid flow configuration or specification.
    #[error("invalid flow specification: {0}")]
    InvalidFlow(String),

    /// Cyclic dependency detected within a flow graph or VersionSet.
    #[error("cyclic dependency detected in flow: {0}")]
    CyclicDependency(String),

    /// A step or package depends on another node that does not exist in the closure.
    #[error("step {step:?} depends on non-existent step {missing:?}")]
    MissingDependency {
        /// Identifier of the step or package declaring the dependency.
        step: String,
        /// Identifier of the missing dependency.
        missing: String,
    },

    /// Specified step was not found.
    #[error("step {0:?} not found in flow")]
    StepNotFound(String),

    /// Execution error during activity or provider processing.
    #[error("activity execution error: {0}")]
    ActivityError(String),

    /// A package version conflict was detected in a VersionSet.
    #[error("version conflict in VersionSet for package {package}: {message}")]
    VersionConflict {
        /// Package name.
        package: String,
        /// Description of the conflict.
        message: String,
    },

    /// Invalid VersionSet manifest or specification.
    #[error("invalid VersionSet manifest: {0}")]
    InvalidVersionSet(String),

    /// A security containment, capability attenuation, or governance invariant failed.
    #[error("security violation: {0}")]
    SecurityViolation(String),

    /// A required claim, finding, or paper field was empty or missing.
    #[error("missing required field: {0}")]
    MissingClaimField(&'static str),

    /// A non-ASCII byte was found at the given byte offset.
    #[error("non-ASCII byte at offset {0}")]
    NonAscii(usize),

    /// Invalid finding type string.
    #[error("invalid finding type {0:?}; expected empirical, theoretical, or synthesis")]
    InvalidType(String),

    /// Invalid finding status string.
    #[error("invalid finding status {0:?}; expected verified, provisional, or refuted")]
    InvalidStatus(String),

    /// Invalid ISO-8601 date string.
    #[error("invalid date {0:?}; expected YYYY-MM-DD")]
    InvalidDate(String),

    /// Invalid source citation string.
    #[error(
        "invalid source citation {0:?}; expected owner/repo@sha:path, arxiv:, doi:, or https://"
    )]
    InvalidSource(String),

    /// Validation error on a domain resource or manifest.
    #[error("{0}")]
    Validation(String),
}

/// Stable CLI failure category mapped to a deterministic process exit code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// Unclassified or transport error (exit code 1).
    Other,
    /// Invalid arguments, flags, or user input (exit code 2).
    Usage,
    /// Missing or invalid authentication credentials (exit code 3).
    Auth,
    /// Requested entity or resource was not found (exit code 4).
    NotFound,
    /// Linear API rate limit or complexity quota exhausted (exit code 5).
    RateLimit,
    /// Operation refused by dry-run guard, duplicate guard, or permission check (exit code 6).
    Refused,
}

impl ErrorKind {
    /// Return the stable process exit code (`1..=6`) for this error kind.
    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::Other => 1,
            Self::Usage => 2,
            Self::Auth => 3,
            Self::NotFound => 4,
            Self::RateLimit => 5,
            Self::Refused => 6,
        }
    }

    /// Return the machine-readable snake_case identifier for this error kind.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Other => "other",
            Self::Usage => "usage",
            Self::Auth => "auth",
            Self::NotFound => "not_found",
            Self::RateLimit => "rate_limit",
            Self::Refused => "refused",
        }
    }
}

impl fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Structured CLI error carrying an [`ErrorKind`], exit code, message, and remediation hint.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[error("{message}")]
pub struct CliError {
    /// Numeric exit code (`1..=6`).
    pub code: u8,
    /// Error classification.
    pub kind: ErrorKind,
    /// Human- and machine-readable error message.
    pub message: String,
    /// Optional remediation hint.
    pub hint: String,
}

impl CliError {
    /// Construct a new [`CliError`] with the given kind, message, and hint.
    #[must_use]
    pub fn new(kind: ErrorKind, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            code: kind.code(),
            kind,
            message: message.into(),
            hint: hint.into(),
        }
    }

    /// Construct a usage error (exit code 2).
    #[must_use]
    pub fn usage(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(ErrorKind::Usage, message, hint)
    }

    /// Construct an authentication error (exit code 3).
    #[must_use]
    pub fn auth(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(ErrorKind::Auth, message, hint)
    }

    /// Construct a not-found error (exit code 4).
    #[must_use]
    pub fn not_found(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message, hint)
    }

    /// Construct a rate-limit error (exit code 5).
    #[must_use]
    pub fn rate_limit(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(ErrorKind::RateLimit, message, hint)
    }

    /// Construct a refused error (exit code 6).
    #[must_use]
    pub fn refused(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(ErrorKind::Refused, message, hint)
    }

    /// Construct an unclassified/other error (exit code 1).
    #[must_use]
    pub fn other(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(ErrorKind::Other, message, hint)
    }
}

/// JSON error envelope payload written to `stderr` when `--json` is active.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    /// Inner error record.
    pub error: ErrorEnvelopeBody,
}

/// Inner fields of [`ErrorEnvelope`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorEnvelopeBody {
    /// Exit code (`1..=6`).
    pub code: u8,
    /// Error classification (`usage`, `auth`, `not_found`, `rate_limit`, `refused`, `other`).
    pub kind: ErrorKind,
    /// Redacted message string.
    pub message: String,
    /// Redacted remediation hint string.
    pub hint: String,
}

/// Build an [`ErrorEnvelope`] with optional credential redaction and fallback hint merging.
#[must_use]
pub fn error_envelope(
    err: &CliError,
    fallback_hint: &str,
    redact_secret: Option<&str>,
) -> ErrorEnvelope {
    let redact = |text: &str| -> String {
        match redact_secret {
            Some(secret) if !secret.is_empty() => text.replace(secret, "[redacted]"),
            _ => text.to_string(),
        }
    };

    let combined_hint = match (err.hint.trim().is_empty(), fallback_hint.trim().is_empty()) {
        (true, true) => String::new(),
        (false, true) => err.hint.clone(),
        (true, false) => fallback_hint.to_string(),
        (false, false) => format!("{} {}", err.hint, fallback_hint),
    };

    ErrorEnvelope {
        error: ErrorEnvelopeBody {
            code: err.code,
            kind: err.kind,
            message: redact(&err.message),
            hint: redact(&combined_hint),
        },
    }
}

/// Render a [`CliError`] for `stderr` (either single-line JSON or human text) and return its exit code.
#[must_use]
pub fn format_cli_error(
    err: &CliError,
    json: bool,
    fallback_hint: &str,
    redact_secret: Option<&str>,
) -> (u8, String) {
    let env = error_envelope(err, fallback_hint, redact_secret);
    let out = if json {
        let serialized = serde_json::to_string(&env).unwrap_or_else(|_| {
            format!(
                "{{\"error\":{{\"code\":{},\"kind\":\"{}\",\"message\":\"error\",\"hint\":\"\"}}}}",
                env.error.code,
                env.error.kind.as_str()
            )
        });
        format!("{serialized}\n")
    } else if env.error.hint.is_empty() {
        format!("error: {}\n", env.error.message)
    } else {
        format!("error: {}\n{}\n", env.error.message, env.error.hint)
    };
    (env.error.code, out)
}

/// Diagnostic fields extracted from an HTTP / GraphQL response for boundary classification.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApiErrorInput {
    /// Optional HTTP status code (e.g. 400, 401, 403, 404, 429).
    pub status: Option<u16>,
    /// Error type/code tokens from top-level or GraphQL `extensions`.
    pub types: Vec<String>,
    /// Top-level error message.
    pub message: String,
    /// First GraphQL error message, if present.
    pub first_error_message: Option<String>,
    /// Whether Linear marked the error `userError: true` or `false`.
    pub user_error: Option<bool>,
    /// Optional error class/name (e.g. `"GuardrailError"`).
    pub name: Option<String>,
}

fn strip_serialized_payload(text: &str) -> &str {
    let line = text.lines().next().unwrap_or("");
    let line = line.split(": {\"response\"").next().unwrap_or(line);
    line.split(": {\"request\"").next().unwrap_or(line).trim()
}

/// Map an HTTP / GraphQL failure into a stable [`CliError`] without leaking request bodies or headers.
#[must_use]
pub fn classify_api_error(input: &ApiErrorInput) -> CliError {
    let types_joined = input.types.join(" ").to_ascii_lowercase();
    let msg_lower = input.message.to_ascii_lowercase();
    let detail = input
        .first_error_message
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&input.message);
    let summary = strip_serialized_payload(detail);
    let base_summary = if summary.is_empty() || summary == "[object Object]" {
        "Linear rejected an invalid input."
    } else {
        summary
    };
    let usage_message = match input.user_error {
        Some(flag) => format!("{base_summary} (userError={flag})"),
        None => base_summary.to_string(),
    };

    if input.status == Some(429)
        || types_joined.contains("ratelimit")
        || types_joined.contains("rate_limit")
        || msg_lower.contains("ratelimited")
        || msg_lower.contains("rate limit")
        || msg_lower.contains("too many requests")
    {
        return CliError::rate_limit(
            "Linear API rate limit exhausted.",
            "Wait for quota to reset; check linearctl ratelimit --json.",
        );
    }

    if input.status == Some(401)
        || types_joined.contains("authentication")
        || types_joined.contains("unauthenticated")
        || types_joined.contains("invalid_api_key")
    {
        return CliError::auth(
            "Linear authentication failed.",
            "Set a valid LINEAR_API_KEY in the environment.",
        );
    }

    if input.status == Some(404)
        || types_joined.contains("entitynotfound")
        || types_joined.contains("not_found")
    {
        return CliError::not_found("Requested resource was not found.", "");
    }

    if input.status == Some(403)
        || types_joined.contains("forbidden")
        || types_joined.contains("permission")
    {
        return CliError::refused("Permission denied for this operation.", "");
    }

    let detail_lower = detail.to_ascii_lowercase();
    if detail_lower.contains("missing duplicate relation")
        || detail_lower.contains(
            "issues can only be moved to a duplicate state when a duplicate issue relation exists",
        )
    {
        return CliError::usage(
            usage_message,
            "Use linearctl close <id> --duplicate-of <canonical>, or linearctl update <id> --duplicate-of <canonical> to create the relation first.",
        );
    }

    if types_joined.contains("invalid_input")
        || types_joined.contains("invalid input")
        || types_joined.contains("invalidinput")
        || types_joined.contains("user_input")
        || types_joined.contains("user input")
        || types_joined.contains("userinput")
        || types_joined.contains("user_error")
        || types_joined.contains("user error")
        || types_joined.contains("usererror")
        || types_joined.contains("bad_user_input")
        || input.user_error == Some(true)
    {
        return CliError::usage(usage_message, "");
    }

    if input.name.as_deref() == Some("GuardrailError") {
        return CliError::refused(input.message.clone(), "");
    }

    let summary_top = input
        .message
        .lines()
        .next()
        .unwrap_or("")
        .split(": {\"response\"")
        .next()
        .unwrap_or("");
    CliError::other(summary_top, "")
}

/// One failed item in a batch operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchFailure {
    /// Optional error message.
    pub error: Option<String>,
    /// Optional classified error kind.
    pub kind: Option<ErrorKind>,
}

/// Verify that a batch operation had zero failed rows and zero unresolved identifiers.
///
/// # Errors
///
/// Returns a [`CliError`] if `failed` or `unresolved` is non-empty.
pub fn assert_batch_succeeded(
    failed: &[BatchFailure],
    unresolved: &[String],
) -> Result<(), CliError> {
    if !failed.is_empty() {
        let kinds: BTreeSet<ErrorKind> = failed
            .iter()
            .map(|f| f.kind.unwrap_or(ErrorKind::Other))
            .collect();
        let kind = if kinds.len() == 1 {
            kinds.into_iter().next().unwrap_or(ErrorKind::Other)
        } else {
            ErrorKind::Other
        };
        return Err(CliError::new(
            kind,
            format!(
                "{} batch item(s) failed; inspect outcomes on stdout.",
                failed.len()
            ),
            "Some writes may have succeeded; re-read before retrying failed items.",
        ));
    }
    if !unresolved.is_empty() {
        return Err(CliError::not_found(
            format!(
                "{} issue(s) were not found; inspect unresolved identifiers on stdout.",
                unresolved.len()
            ),
            "",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_match_contract() {
        assert_eq!(ErrorKind::Other.code(), 1);
        assert_eq!(ErrorKind::Usage.code(), 2);
        assert_eq!(ErrorKind::Auth.code(), 3);
        assert_eq!(ErrorKind::NotFound.code(), 4);
        assert_eq!(ErrorKind::RateLimit.code(), 5);
        assert_eq!(ErrorKind::Refused.code(), 6);
    }

    #[test]
    fn sdk_codes_and_batch_failures_preserve_stable_kinds() {
        let not_found = classify_api_error(&ApiErrorInput {
            status: Some(404),
            ..Default::default()
        });
        assert_eq!(not_found.code, 4);

        let rate_limited = classify_api_error(&ApiErrorInput {
            types: vec!["RATELIMITED".to_string()],
            ..Default::default()
        });
        assert_eq!(rate_limited.code, 5);

        let auth_batch = assert_batch_succeeded(
            &[BatchFailure {
                error: Some("failed".to_string()),
                kind: Some(ErrorKind::Auth),
            }],
            &[],
        )
        .unwrap_err();
        assert_eq!(auth_batch.code, 3);

        let rl_batch = assert_batch_succeeded(
            &[BatchFailure {
                error: None,
                kind: Some(ErrorKind::RateLimit),
            }],
            &[],
        )
        .unwrap_err();
        assert_eq!(rl_batch.code, 5);

        let unres = assert_batch_succeeded(&[], &["ENG-999".to_string()]).unwrap_err();
        assert_eq!(unres.code, 4);
    }

    #[test]
    fn user_error_formats_message() {
        let err = classify_api_error(&ApiErrorInput {
            status: Some(400),
            types: vec!["userinput".to_string()],
            first_error_message: Some(
                "Duplicate label name - Label \"example-label\" already exists in team Example Team"
                    .to_string(),
            ),
            user_error: Some(true),
            ..Default::default()
        });
        assert_eq!(err.code, 2);
        assert_eq!(err.kind, ErrorKind::Usage);
        assert_eq!(
            err.message,
            "Duplicate label name - Label \"example-label\" already exists in team Example Team (userError=true)"
        );
    }
}
