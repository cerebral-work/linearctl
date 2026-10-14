//! Priority flag parsing and formatting (`0..=4` or `"none"`).

use crate::error::CliError;

/// Parse a `--priority` flag value (`"0"`..=`"4"` or `"none"` -> `0`).
///
/// # Errors
///
/// Returns a [`CliError`] (`usage`, exit code 2) if `value` is not an integer in `0..=4` or `"none"`.
pub fn parse_priority(value: &str) -> Result<u8, CliError> {
    if value == "none" {
        return Ok(0);
    }
    if let Ok(p) = value.parse::<i64>() {
        if (0..=4).contains(&p) {
            return Ok(p as u8);
        }
    }
    let quoted = serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""));
    Err(CliError::usage(
        format!("--priority must be 0-4 or \"none\", got {quoted}."),
        "",
    ))
}

/// Human-readable label for a Linear priority number (`0..=4`).
#[must_use]
pub const fn priority_label(priority: u8) -> &'static str {
    match priority {
        1 => "Urgent",
        2 => "High",
        3 => "Medium",
        4 => "Low",
        _ => "No priority",
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_and_rejects_invalid_priority() {
        assert_eq!(parse_priority("none").unwrap(), 0);
        assert_eq!(parse_priority("0").unwrap(), 0);
        assert_eq!(parse_priority("1").unwrap(), 1);
        assert_eq!(parse_priority("4").unwrap(), 4);
        assert!(parse_priority("5").is_err());
        assert!(parse_priority("-1").is_err());
        assert!(parse_priority("high").is_err());
    }
}
