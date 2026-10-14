//! Pure relative-duration parsing and civil UTC timestamp conversion.

use crate::error::CliError;

/// Milliseconds in one second.
pub const MS_PER_SECOND: i64 = 1_000;
/// Milliseconds in one minute.
pub const MS_PER_MINUTE: i64 = 60_000;
/// Milliseconds in one hour.
pub const MS_PER_HOUR: i64 = 3_600_000;
/// Milliseconds in one day.
pub const MS_PER_DAY: i64 = 86_400_000;
/// Milliseconds in one week.
pub const MS_PER_WEEK: i64 = 604_800_000;

/// Parse a relative duration string (`7d`, `24h`, `2w`, `30m`, `45s`, or bare integer days) into milliseconds.
///
/// # Errors
///
/// Returns a [`CliError`] (`usage`, exit code 2) if `spec` is malformed.
pub fn parse_duration_ms(spec: &str) -> Result<i64, CliError> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err(CliError::usage(
            format!("invalid --since value: \"{spec}\" (expected e.g. 7d, 24h, 2w, 30m)"),
            "",
        ));
    }

    let digit_count = trimmed.chars().take_while(char::is_ascii_digit).count();
    if digit_count == 0 {
        return Err(CliError::usage(
            format!("invalid --since value: \"{spec}\" (expected e.g. 7d, 24h, 2w, 30m)"),
            "",
        ));
    }

    let (num_str, rest) = trimmed.split_at(digit_count);
    let unit = rest.trim();
    let n: i64 = num_str.parse().map_err(|_| {
        CliError::usage(
            format!("invalid --since value: \"{spec}\" (expected e.g. 7d, 24h, 2w, 30m)"),
            "",
        )
    })?;

    let factor = match unit {
        "" | "d" => MS_PER_DAY,
        "s" => MS_PER_SECOND,
        "m" => MS_PER_MINUTE,
        "h" => MS_PER_HOUR,
        "w" => MS_PER_WEEK,
        _ => {
            return Err(CliError::usage(
                format!("invalid --since value: \"{spec}\" (expected e.g. 7d, 24h, 2w, 30m)"),
                "",
            ));
        }
    };

    Ok(n.saturating_mul(factor))
}

/// Convert a relative duration specification (`7d`, `24h`, etc.) into a past UTC epoch timestamp in milliseconds.
///
/// # Errors
///
/// Returns a [`CliError`] (`usage`, exit code 2) if `spec` is malformed.
pub fn since_to_epoch_ms(spec: &str, now_ms: i64) -> Result<i64, CliError> {
    let delta = parse_duration_ms(spec)?;
    Ok(now_ms.saturating_sub(delta))
}

/// Convert days since 1970-01-01 to `(year, month, day)` in the proleptic Gregorian calendar (Howard Hinnant's algorithm).
#[must_use]
pub const fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = (y + if m <= 2 { 1 } else { 0 }) as i32;
    (year, m, d)
}

/// Convert `(year, month, day)` in the proleptic Gregorian calendar to days since 1970-01-01.
#[must_use]
pub const fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = (year as i64) - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let m = month;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + (doe as i64) - 719_468
}

/// Format a UTC epoch timestamp in milliseconds as `YYYY-MM-DDTHH:MM:SS.sssZ`.
#[must_use]
pub fn epoch_ms_to_iso(ms: i64) -> String {
    let days = ms.div_euclid(MS_PER_DAY);
    let rem_ms = ms.rem_euclid(MS_PER_DAY) as u64;
    let (year, month, day) = civil_from_days(days);
    let hours = rem_ms / 3_600_000;
    let minutes = (rem_ms % 3_600_000) / 60_000;
    let seconds = (rem_ms % 60_000) / 1_000;
    let millis = rem_ms % 1_000;
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

/// Format a UTC epoch timestamp in milliseconds as `YYYY-MM-DD`.
#[must_use]
pub fn epoch_ms_to_date(ms: i64) -> String {
    let days = ms.div_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Parse an ISO-8601 date (`YYYY-MM-DD`) or timestamp (`YYYY-MM-DDTHH:MM:SS...`) into UTC epoch milliseconds.
#[must_use]
pub fn iso_to_epoch_ms(s: &str) -> Option<i64> {
    let trimmed = s.trim();
    if trimmed.len() < 10 {
        return None;
    }
    let year: i32 = trimmed.get(0..4)?.parse().ok()?;
    if trimmed.as_bytes().get(4).copied()? != b'-' {
        return None;
    }
    let month: u32 = trimmed.get(5..7)?.parse().ok()?;
    if !(1..=12).contains(&month) || trimmed.as_bytes().get(7).copied()? != b'-' {
        return None;
    }
    let day: u32 = trimmed.get(8..10)?.parse().ok()?;
    if !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    if trimmed.len() == 10 {
        return Some(days * MS_PER_DAY);
    }

    let rest = trimmed.get(10..)?;
    let rest = rest.strip_prefix('T').or_else(|| rest.strip_prefix(' '))?;
    if rest.len() < 8 {
        return None;
    }
    let hour: i64 = rest.get(0..2)?.parse().ok()?;
    let min: i64 = rest.get(3..5)?.parse().ok()?;
    let sec: i64 = rest.get(6..8)?.parse().ok()?;
    let mut millis: i64 = 0;
    if let Some(after_sec) = rest.get(8..) {
        if let Some(frac) = after_sec.strip_prefix('.') {
            let digits: String = frac
                .chars()
                .take_while(char::is_ascii_digit)
                .take(3)
                .collect();
            if !digits.is_empty() {
                let parsed: i64 = digits.parse().ok()?;
                millis = match digits.len() {
                    1 => parsed * 100,
                    2 => parsed * 10,
                    _ => parsed,
                };
            }
        }
    }
    Some(
        days * MS_PER_DAY + hour * MS_PER_HOUR + min * MS_PER_MINUTE + sec * MS_PER_SECOND + millis,
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parses_relative_durations() {
        let now = 1_700_000_000_000_i64;
        assert_eq!(since_to_epoch_ms("7d", now).unwrap(), now - 7 * MS_PER_DAY);
        assert_eq!(
            since_to_epoch_ms("24h", now).unwrap(),
            now - 24 * MS_PER_HOUR
        );
        assert_eq!(since_to_epoch_ms("2w", now).unwrap(), now - 2 * MS_PER_WEEK);
        assert_eq!(
            since_to_epoch_ms("30m", now).unwrap(),
            now - 30 * MS_PER_MINUTE
        );
        assert_eq!(
            since_to_epoch_ms("45s", now).unwrap(),
            now - 45 * MS_PER_SECOND
        );
        assert_eq!(since_to_epoch_ms("3", now).unwrap(), now - 3 * MS_PER_DAY);
        assert!(since_to_epoch_ms("abc", now).is_err());
    }

    #[test]
    fn iso_round_trip() {
        let ms = 1_785_240_000_000_i64; // 2026-07-28T12:00:00.000Z
        let iso = epoch_ms_to_iso(ms);
        assert_eq!(iso, "2026-07-28T12:00:00.000Z");
        assert_eq!(epoch_ms_to_date(ms), "2026-07-28");
        assert_eq!(iso_to_epoch_ms(&iso), Some(ms));
    }
}
