//! Absolute path and stack-trace redaction for client-visible errors, ported
//! from the legacy `open-sse/utils/errorPathRedaction.ts`.
//!
//! The scanner works on UTF-16 code units, as the legacy JavaScript does, so
//! indexes, lengths and `charCodeAt` reads keep their meaning; JavaScript
//! `\s` and `toLowerCase` are reproduced rather than approximated.

const SOURCE_EXT: [&str; 8] = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];
const NATIVE_EXT: [&str; 4] = ["node", "so", "dylib", "dll"];
const LEADING_PATH_PUNCTUATION: &str = "'\"`([{<";
const TRAILING_PATH_PUNCTUATION: &str = "'\"`)]}>.,;:!?";
const PATH_SPAN_END_PUNCTUATION: &str = "'\"`)]}>.,;:!?";
const FILE_URI_PREFIX: &str = "file://";
const HTTP_METHODS: [&str; 9] = [
    "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "CONNECT", "TRACE",
];
const CLEAR_PROSE_BOUNDARIES: [&str; 15] = [
    "after", "because", "before", "but", "crashed", "denied", "eacces", "enoent", "expired",
    "failed", "rejected", "retry", "then", "when", "while",
];
const POSIX_FILESYSTEM_ROOTS: [&str; 21] = [
    "/Users",
    "/app",
    "/boot",
    "/data",
    "/dev",
    "/etc",
    "/home",
    "/media",
    "/mnt",
    "/nix",
    "/opt",
    "/private",
    "/proc",
    "/root",
    "/run",
    "/srv",
    "/sys",
    "/tmp",
    "/usr",
    "/var",
    "/workspace",
];
const WINDOWS_ROOT_RELATIVE_ROOTS: [&str; 5] =
    ["program files", "programdata", "temp", "users", "windows"];
/// The marker an earlier sanitizer pass wrote over a credential.
const REDACTION_MARKER: &str = "[REDACTED]";
const PATH: &str = "<path>";

type U = [u16];

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn text(value: &U) -> String {
    String::from_utf16_lossy(value)
}

/// `charCodeAt`: none past the end (JavaScript NaN).
fn at(value: &U, index: usize) -> Option<u16> {
    value.get(index).copied()
}

/// JavaScript `\s`.
fn js_whitespace(code: u16) -> bool {
    matches!(
        code,
        0x09..=0x0d
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

fn ws_at(value: &U, index: usize) -> bool {
    at(value, index).is_some_and(js_whitespace)
}

fn in_set(code: Option<u16>, set: &str) -> bool {
    code.is_some_and(|code| set.encode_utf16().any(|unit| unit == code))
}

fn digit(code: Option<u16>) -> bool {
    code.is_some_and(|code| (0x30..=0x39).contains(&code))
}

fn letter(code: Option<u16>) -> bool {
    code.is_some_and(|code| (0x41..=0x5a).contains(&code) || (0x61..=0x7a).contains(&code))
}

fn alnum(code: Option<u16>) -> bool {
    digit(code) || letter(code)
}

/// JavaScript `toLowerCase` of a slice.
fn lower(value: &U, start: usize, end: usize) -> String {
    let end = end.min(value.len());
    if start >= end {
        return String::new();
    }
    text(&value[start..end]).to_lowercase()
}

fn starts_with_at(value: &U, start: usize, literal: &str) -> bool {
    let literal = units(literal);
    value
        .get(start..start + literal.len())
        .is_some_and(|slice| slice == literal.as_slice())
}

fn index_of(value: &U, needle: &str, from: usize) -> Option<usize> {
    let needle = units(needle);
    if needle.is_empty() {
        return Some(from.min(value.len()));
    }
    (from..=value.len().saturating_sub(needle.len()))
        .find(|start| value.get(*start..start + needle.len()) == Some(needle.as_slice()))
}

/// JavaScript `lastIndexOf(char, fromIndex)`: a negative start still checks 0.
fn last_index_of(value: &U, code: u16, from: isize) -> Option<usize> {
    if value.is_empty() {
        return None;
    }
    let from = from.clamp(0, value.len() as isize - 1) as usize;
    (0..=from).rev().find(|index| value[*index] == code)
}

fn is_windows_absolute_path_at(value: &U, start: usize) -> bool {
    let remaining = value.len().saturating_sub(start);
    if remaining > 2 {
        let (first, second) = (at(value, start), at(value, start + 1));
        if (first == Some(0x5c) && second == Some(0x5c))
            || (first == Some(0x2f) && second == Some(0x2f))
        {
            return true;
        }
    }
    if remaining < 3 || at(value, start + 1) != Some(0x3a) {
        return false;
    }
    letter(at(value, start)) && matches!(at(value, start + 2), Some(0x2f | 0x5c))
}

fn is_windows_root_relative_path_at(value: &U, start: usize) -> bool {
    if at(value, start) != Some(0x5c)
        || at(value, start + 1) == Some(0x5c)
        || ws_at(value, start + 1)
    {
        return false;
    }
    let token_end = find_token_end(value, start);
    let mut first_separator = start + 1;
    while first_separator < token_end && at(value, first_separator) != Some(0x5c) {
        first_separator += 1;
    }
    let root = lower(value, start + 1, first_separator);
    if WINDOWS_ROOT_RELATIVE_ROOTS.contains(&root.as_str()) {
        return true;
    }
    first_separator + 1 < token_end
        || token_contains_path_extension_evidence(value, start + 1, token_end)
}

fn has_absolute_file_uri_at(value: &U, start: usize) -> bool {
    let prefix_end = start + FILE_URI_PREFIX.len();
    value.len() > prefix_end
        && lower(value, start, prefix_end) == FILE_URI_PREFIX
        && !ws_at(value, prefix_end)
}

fn is_syntactically_absolute_path_at(value: &U, start: usize) -> bool {
    at(value, start) == Some(0x2f)
        || is_windows_absolute_path_at(value, start)
        || is_windows_root_relative_path_at(value, start)
        || has_absolute_file_uri_at(value, start)
}

fn has_http_url_scheme_before(value: &U, slash: usize) -> bool {
    ["http:", "https:"].iter().any(|scheme| {
        let Some(scheme_start) = slash.checked_sub(scheme.len()) else {
            return false;
        };
        lower(value, scheme_start, slash) == *scheme
            && (scheme_start == 0 || !alnum(at(value, scheme_start - 1)))
    })
}

fn is_route_context_word(word: &str) -> bool {
    word == "Route" || HTTP_METHODS.contains(&word)
}

fn has_route_context_before(value: &U, candidate: usize) -> bool {
    let mut index = candidate as isize - 1;
    while index >= 0
        && (ws_at(value, index as usize) || matches!(at(value, index as usize), Some(0x28 | 0x3a)))
    {
        index -= 1;
    }
    let context_end = (index + 1) as usize;
    while index >= 0 && alnum(at(value, index as usize)) {
        index -= 1;
    }
    is_route_context_word(&text(&value[(index + 1) as usize..context_end]))
}

fn is_route_context_token(token: &U) -> bool {
    let mut end = token.len();
    while end > 0 && !alnum(at(token, end - 1)) {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && alnum(at(token, start - 1)) {
        start -= 1;
    }
    is_route_context_word(&text(&token[start..end]))
}

fn matches_posix_root_at(value: &U, start: usize, root: &str) -> bool {
    if !starts_with_at(value, start, root) {
        return false;
    }
    let root_end = start + root.len();
    root_end == value.len()
        || at(value, root_end) == Some(0x2f)
        || in_set(at(value, root_end), PATH_SPAN_END_PUNCTUATION)
}

fn is_known_posix_path_at(value: &U, start: usize) -> bool {
    POSIX_FILESYSTEM_ROOTS
        .iter()
        .any(|root| matches_posix_root_at(value, start, root))
}

fn looks_like_absolute_path(token: &U) -> bool {
    if token.len() < 4 || token.len() > 2048 {
        return false;
    }
    let posix = at(token, 0) == Some(0x2f);
    let windows =
        is_windows_absolute_path_at(token, 0) || is_windows_root_relative_path_at(token, 0);
    if !posix && !windows {
        return false;
    }
    if windows || is_known_posix_path_at(token, 0) {
        return true;
    }
    let Some(dot) = last_index_of(token, 0x2e, token.len() as isize - 1) else {
        return false;
    };
    if dot == 0 || dot == token.len() - 1 {
        return false;
    }
    let extension = text(&token[dot + 1..]);
    let extension = extension.split(':').next().unwrap_or("").to_lowercase();
    SOURCE_EXT.contains(&extension.as_str()) || NATIVE_EXT.contains(&extension.as_str())
}

fn redact_absolute_path_token(token: &U, follows_route_context: bool) -> Vec<u16> {
    let mut start = 0;
    let mut end = token.len();
    while start < end && in_set(at(token, start), LEADING_PATH_PUNCTUATION) {
        start += 1;
    }
    while end > start && in_set(at(token, end - 1), TRAILING_PATH_PUNCTUATION) {
        end -= 1;
    }
    let candidate = &token[start..end];
    let file_uri = has_absolute_file_uri_at(candidate, 0);
    let path = if file_uri {
        &candidate[FILE_URI_PREFIX.len()..]
    } else {
        candidate
    };
    if !file_uri
        && !is_windows_absolute_path_at(path, 0)
        && !is_windows_root_relative_path_at(path, 0)
        && at(path, 0) == Some(0x2f)
        && follows_route_context
    {
        return token.to_vec();
    }
    if !file_uri && !looks_like_absolute_path(path) {
        return token.to_vec();
    }
    let mut out = token[..start].to_vec();
    out.extend(units(PATH));
    out.extend_from_slice(&token[end..]);
    out
}

fn find_path_quote(value: &U, start: usize, quote: u16, take_first: bool) -> usize {
    let find = |from: usize| (from..value.len()).find(|index| value[*index] == quote);
    let Some(mut candidate) = find(start) else {
        return value.len();
    };
    if take_first {
        return candidate;
    }
    while candidate < value.len() {
        let Some(next) = find(candidate + 1) else {
            return candidate;
        };
        if is_syntactically_absolute_path_at(value, next + 1) {
            return candidate;
        }
        candidate = next;
    }
    value.len()
}

fn redact_quoted_absolute_paths(value: &U) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    let mut changed = false;
    let mut copy_start = 0;
    let mut index = 0;
    while index < value.len() {
        let quote = value[index];
        if !matches!(quote, 0x27 | 0x22 | 0x60) {
            index += 1;
            continue;
        }
        let candidate_start = index + 1;
        if !is_syntactically_absolute_path_at(value, candidate_start) {
            index += 1;
            continue;
        }
        let shielded_route = at(value, candidate_start) == Some(0x2f)
            && !is_windows_absolute_path_at(value, candidate_start)
            && has_route_context_before(value, index);
        let closing = find_path_quote(value, candidate_start, quote, shielded_route);
        if shielded_route {
            if closing >= value.len() {
                break;
            }
            index = closing + 1;
            continue;
        }
        out.extend_from_slice(&value[copy_start..candidate_start]);
        out.extend(units(PATH));
        changed = true;
        copy_start = closing;
        if closing >= value.len() {
            break;
        }
        index = closing + 1;
    }
    if !changed {
        return value.to_vec();
    }
    out.extend_from_slice(&value[copy_start.min(value.len())..]);
    out
}

/// Returns the end of a filename extension at `dot`, or none.
fn find_path_extension_end(value: &U, dot: usize) -> Option<usize> {
    let mut end = dot + 1;
    let max_end = value.len().min(end + 16);
    while end < max_end && alnum(at(value, end)) {
        end += 1;
    }
    if end == dot + 1 || (end == max_end && alnum(at(value, end))) {
        return None;
    }
    if !(dot + 1..end).any(|index| letter(at(value, index))) {
        return None;
    }
    while at(value, end) == Some(0x3a) {
        let mut coordinate_end = end + 1;
        if !digit(at(value, coordinate_end)) {
            break;
        }
        while coordinate_end < value.len() && digit(at(value, coordinate_end)) {
            coordinate_end += 1;
        }
        end = coordinate_end;
    }
    (end == value.len() || ws_at(value, end) || in_set(at(value, end), PATH_SPAN_END_PUNCTUATION))
        .then_some(end)
}

fn find_token_end(value: &U, start: usize) -> usize {
    let mut end = start;
    while end < value.len() && !ws_at(value, end) {
        end += 1;
    }
    end
}

fn find_extension_end_in_token(value: &U, start: usize, end: usize) -> Option<usize> {
    let mut last = None;
    for index in start..end {
        match at(value, index) {
            Some(0x2f | 0x5c) => last = None,
            Some(0x2e) => {
                if let Some(extension_end) = find_path_extension_end(value, index) {
                    if extension_end <= end {
                        last = Some(extension_end);
                    }
                }
            }
            _ => {}
        }
    }
    last
}

fn token_contains_path_extension_evidence(value: &U, start: usize, end: usize) -> bool {
    for dot in start..end {
        if at(value, dot) != Some(0x2e) {
            continue;
        }
        let mut extension_end = dot + 1;
        let max_end = end.min(extension_end + 16);
        let mut has_letter = false;
        while extension_end < max_end && alnum(at(value, extension_end)) {
            has_letter |= letter(at(value, extension_end));
            extension_end += 1;
        }
        if extension_end == dot + 1
            || !has_letter
            || (extension_end == max_end && extension_end < end && alnum(at(value, extension_end)))
        {
            continue;
        }
        if extension_end == end
            || matches!(at(value, extension_end), Some(0x2f | 0x5c))
            || in_set(at(value, extension_end), PATH_SPAN_END_PUNCTUATION)
        {
            return true;
        }
    }
    false
}

fn token_contains_path_separator(value: &U, start: usize, end: usize) -> bool {
    (start..end).any(|index| matches!(at(value, index), Some(0x2f | 0x5c)))
}

fn remainder_contains_filesystem_separator(value: &U, start: usize) -> bool {
    let mut token_start = start;
    let mut previous: &U = &[];
    while token_start < value.len() {
        while token_start < value.len() && ws_at(value, token_start) {
            token_start += 1;
        }
        if token_start >= value.len() {
            return false;
        }
        let token_end = find_token_end(value, token_start);
        let token = lower(value, token_start, token_end);
        let http_url = token.contains("http://") || token.contains("https://");
        let mut separator = token_start;
        while separator < token_end && !matches!(at(value, separator), Some(0x2f | 0x5c)) {
            separator += 1;
        }
        let preceding = (separator > token_start)
            .then(|| at(value, separator - 1))
            .flatten();
        let context_index = if matches!(preceding, Some(0x27 | 0x22 | 0x60)) {
            separator - 1
        } else {
            separator
        };
        let shielded_route = separator < token_end
            && at(value, separator) == Some(0x2f)
            && !is_windows_absolute_path_at(value, separator)
            && (is_route_context_token(previous) || has_route_context_before(value, context_index));
        if !http_url && separator < token_end && !shielded_route {
            return true;
        }
        previous = &value[token_start..token_end];
        token_start = token_end;
    }
    false
}

fn trim_path_span_end(value: &U, start: usize, mut end: usize) -> usize {
    while end > start && in_set(at(value, end - 1), PATH_SPAN_END_PUNCTUATION) {
        end -= 1;
    }
    end
}

fn is_clear_prose_boundary_token(value: &U, mut start: usize, end: usize) -> bool {
    while start < end && in_set(at(value, start), LEADING_PATH_PUNCTUATION) {
        start += 1;
    }
    let end = trim_path_span_end(value, start, end);
    CLEAR_PROSE_BOUNDARIES.contains(&lower(value, start, end).as_str())
}

/// True when the token starting at `index` carries a redaction marker.
fn starts_redacted_token(value: &U, index: usize) -> bool {
    let end = find_token_end(value, index);
    text(&value[index..end]).contains(REDACTION_MARKER)
}

fn find_unquoted_path_end(
    value: &U,
    start: usize,
    accept_first_token_punctuation: bool,
    accept_endpoint_before_another_absolute: bool,
    fail_closed_ambiguity: bool,
) -> Option<usize> {
    let mut token_start = start;
    let mut first_token = true;
    let mut first_token_end: Option<usize> = None;
    let mut first_trimmed_token_end: Option<usize> = None;
    let mut last_path_token_end: Option<usize> = None;
    let mut resolved_extension_end: Option<usize> = None;
    let mut filesystem_evidence = false;
    let mut unresolved_fragments = false;

    let resolve = |ignore_ambiguity: bool,
                   resolved: Option<usize>,
                   unresolved: bool,
                   evidence: bool,
                   last_path: Option<usize>,
                   first_trimmed: Option<usize>,
                   first_end: Option<usize>|
     -> Option<usize> {
        if resolved.is_some() {
            return resolved;
        }
        if unresolved && !ignore_ambiguity {
            return fail_closed_ambiguity.then_some(value.len());
        }
        if evidence && last_path.is_some() {
            return last_path;
        }
        if accept_first_token_punctuation {
            if let (Some(trimmed), Some(end)) = (first_trimmed, first_end) {
                if trimmed < end {
                    return Some(trimmed);
                }
            }
        }
        None
    };
    macro_rules! resolve_endpoint {
        ($ignore:expr) => {
            resolve(
                $ignore,
                resolved_extension_end,
                unresolved_fragments,
                filesystem_evidence,
                last_path_token_end,
                first_trimmed_token_end,
                first_token_end,
            )
        };
    }

    while token_start < value.len() {
        let token_end = find_token_end(value, token_start);
        let extension_end = find_extension_end_in_token(value, token_start, token_end);
        let trimmed_token_end = trim_path_span_end(value, token_start, token_end);
        if first_token {
            first_token_end = Some(token_end);
            first_trimmed_token_end = Some(trimmed_token_end);
            last_path_token_end = Some(trimmed_token_end);
        } else if is_clear_prose_boundary_token(value, token_start, token_end)
            && (!remainder_contains_filesystem_separator(value, token_end)
                || (!fail_closed_ambiguity && !filesystem_evidence))
        {
            return resolve_endpoint!(false);
        }

        let contains_separator = token_contains_path_separator(value, token_start, token_end);
        let contains_extension_evidence =
            token_contains_path_extension_evidence(value, token_start, token_end);
        if contains_separator {
            last_path_token_end = Some(trimmed_token_end);
            filesystem_evidence = true;
            unresolved_fragments = false;
            resolved_extension_end = extension_end;
            if extension_end.is_none() && contains_extension_evidence {
                resolved_extension_end = Some(trimmed_token_end);
            }
        } else if extension_end.is_some() {
            resolved_extension_end = extension_end;
            filesystem_evidence = true;
            unresolved_fragments = false;
        } else if contains_extension_evidence {
            resolved_extension_end = Some(trimmed_token_end);
            filesystem_evidence = true;
            unresolved_fragments = false;
        } else if !first_token {
            unresolved_fragments = true;
        }

        let mut next_token_start = token_end;
        while next_token_start < value.len() && ws_at(value, next_token_start) {
            next_token_start += 1;
        }
        if next_token_start >= value.len() {
            return resolve_endpoint!(false);
        }
        if starts_redacted_token(value, next_token_start) {
            return resolve_endpoint!(true);
        }
        if is_syntactically_absolute_path_at(value, next_token_start) {
            let endpoint = resolve_endpoint!(has_route_context_before(value, next_token_start));
            if endpoint.is_some() {
                return endpoint;
            }
            return if accept_endpoint_before_another_absolute {
                last_path_token_end
            } else {
                None
            };
        }
        token_start = next_token_start;
        first_token = false;
    }
    resolve_endpoint!(false)
}

fn is_unquoted_posix_span_candidate_at(value: &U, start: usize) -> bool {
    let token_end = find_token_end(value, start);
    let token = &value[start..token_end];
    if is_known_posix_path_at(token, 0)
        || find_extension_end_in_token(value, start, token_end).is_some()
        || token_contains_path_extension_evidence(value, start, token_end)
    {
        return true;
    }
    let slashes = token.iter().filter(|code| **code == 0x2f).count();
    slashes >= 1 && token.len() > 1
}

fn redact_unquoted_absolute_path_spans(value: &U) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    let mut changed = false;
    let mut copy_start = 0;
    let mut index = 0;
    while index < value.len() {
        let previous = index
            .checked_sub(1)
            .and_then(|previous| at(value, previous));
        let follows_quote = matches!(previous, Some(0x27 | 0x22 | 0x60));
        let common_boundary = index == 0
            || previous.is_some_and(js_whitespace)
            || in_set(previous, LEADING_PATH_PUNCTUATION)
            || matches!(
                previous,
                Some(0x3d | 0x3a | 0x2c | 0x3b | 0x2e | 0x3e | 0x7c)
            );
        let forward_slash_unc =
            at(value, index) == Some(0x2f) && at(value, index + 1) == Some(0x2f);
        let http_url =
            forward_slash_unc && previous == Some(0x3a) && has_http_url_scheme_before(value, index);
        let windows_path = !follows_quote
            && (is_windows_absolute_path_at(value, index)
                || is_windows_root_relative_path_at(value, index))
            && !http_url;
        let file_uri_path = !follows_quote && has_absolute_file_uri_at(value, index);
        let posix_path = !follows_quote
            && at(value, index) == Some(0x2f)
            && at(value, index + 1) != Some(0x2f)
            && !has_route_context_before(value, index)
            && is_unquoted_posix_span_candidate_at(value, index);
        let boundary = common_boundary || (windows_path && previous == Some(0x3a));
        if !boundary || (!windows_path && !file_uri_path && !posix_path) {
            index += 1;
            continue;
        }
        let known_posix = is_known_posix_path_at(value, index);
        let unequivocal = windows_path || file_uri_path || known_posix;
        match find_unquoted_path_end(value, index, unequivocal, unequivocal, unequivocal) {
            None => {
                // #14110: an unknown-root POSIX candidate with evidence fails
                // closed like a known one.
                if unequivocal || posix_path {
                    out.extend_from_slice(&value[copy_start..index]);
                    out.extend(units(PATH));
                    changed = true;
                    copy_start = value.len();
                    break;
                }
                index += 1;
            }
            Some(end) => {
                out.extend_from_slice(&value[copy_start..index]);
                out.extend(units(PATH));
                changed = true;
                copy_start = end;
                index = end;
            }
        }
    }
    if !changed {
        return value.to_vec();
    }
    out.extend_from_slice(&value[copy_start.min(value.len())..]);
    out
}

fn is_physical_line_separator(code: Option<u16>) -> bool {
    matches!(code, Some(0x0a | 0x0d | 0x2028 | 0x2029))
}

fn serialized_line_separator_length_at(value: &U, start: usize) -> usize {
    if at(value, start) != Some(0x5c) {
        return 0;
    }
    let marker = lower(value, start + 1, start + 2);
    if marker == "n" || marker == "r" {
        return 2;
    }
    match lower(value, start + 1, start + 6).as_str() {
        "u000a" | "u000d" | "u2028" | "u2029" => 6,
        _ => 0,
    }
}

fn has_numeric_line_column_suffix(value: &U, separator: usize) -> bool {
    if at(value, separator) != Some(0x3a) {
        return false;
    }
    let mut index = separator + 1;
    if !digit(at(value, index)) {
        return false;
    }
    while index < value.len() && digit(at(value, index)) {
        index += 1;
    }
    if at(value, index) != Some(0x3a) {
        return false;
    }
    index += 1;
    if !digit(at(value, index)) {
        return false;
    }
    while index < value.len() && digit(at(value, index)) {
        index += 1;
    }
    index == value.len()
}

/// The `:line:column` separator pair of a token (JavaScript `lastIndexOf`).
fn line_separator(token: &U) -> Option<usize> {
    let column = last_index_of(token, 0x3a, token.len() as isize - 1).map_or(-1, |c| c as isize);
    last_index_of(token, 0x3a, column - 1)
}

fn looks_like_relative_stack_location(token: &U) -> bool {
    if token.len() < 6 || token.len() > 2048 {
        return false;
    }
    let last = token.len() as isize - 1;
    let last_separator = last_index_of(token, 0x2f, last)
        .map_or(-1, |i| i as isize)
        .max(last_index_of(token, 0x5c, last).map_or(-1, |i| i as isize));
    if last_separator == last {
        return false;
    }
    let Some(line) =
        line_separator(token).filter(|line| has_numeric_line_column_suffix(token, *line))
    else {
        return false;
    };
    let after = (last_separator + 1) as usize;
    let metadata = [index_of(token, "?", after), index_of(token, "#", after)]
        .into_iter()
        .flatten()
        .filter(|index| *index < line)
        .min();
    let extension_end = metadata.unwrap_or(line);
    let Some(dot) = last_index_of(token, 0x2e, extension_end as isize - 1) else {
        return false;
    };
    if (dot as isize) <= last_separator || dot + 1 == extension_end {
        return false;
    }
    SOURCE_EXT.contains(&lower(token, dot + 1, extension_end).as_str())
}

fn looks_like_url_stack_location(token: &U) -> bool {
    if token.len() < 12 || token.len() > 2048 {
        return false;
    }
    let lowered = text(token).to_lowercase();
    if !lowered.starts_with("http://") && !lowered.starts_with("https://") {
        return false;
    }
    line_separator(token)
        .is_some_and(|line| line > 0 && has_numeric_line_column_suffix(token, line))
}

fn looks_like_node_stack_location(token: &U) -> bool {
    if token.len() < 10 || token.len() > 2048 || !starts_with_at(token, 0, "node:") {
        return false;
    }
    let Some(line) = line_separator(token) else {
        return false;
    };
    if line <= 5 || !has_numeric_line_column_suffix(token, line) {
        return false;
    }
    (5..line).all(|index| {
        alnum(at(token, index)) || matches!(at(token, index), Some(0x2e | 0x2f | 0x5f | 0x2d))
    })
}

fn looks_like_eval_stack_location(token: &U) -> bool {
    token.len() <= 64
        && starts_with_at(token, 0, "[eval]")
        && has_numeric_line_column_suffix(token, 6)
}

fn is_recognized_stack_path_at(value: &U, start: usize) -> bool {
    if has_absolute_file_uri_at(value, start) {
        return true;
    }
    let end = trim_path_span_end(value, start, find_token_end(value, start));
    let token = &value[start.min(end)..end];
    looks_like_absolute_path(token)
        || looks_like_relative_stack_location(token)
        || looks_like_url_stack_location(token)
        || looks_like_node_stack_location(token)
        || looks_like_eval_stack_location(token)
}

/// JavaScript `trim` of a UTF-16 slice.
fn js_trim(value: &U) -> &U {
    let start = value
        .iter()
        .position(|code| !js_whitespace(*code))
        .unwrap_or(value.len());
    let end = value
        .iter()
        .rposition(|code| !js_whitespace(*code))
        .map_or(start, |end| end + 1);
    &value[start..end.max(start)]
}

fn is_stack_frame_label(value: &U, start: usize, end: usize) -> bool {
    let label = js_trim(&value[start..end.min(value.len())]);
    if label.is_empty() || label.len() > 256 {
        return false;
    }
    let first = label[0];
    if !(letter(Some(first)) || matches!(first, 0x5f | 0x24 | 0x3c)) {
        return false;
    }
    // [^A-Za-z0-9_$.[\]<>:/ -]
    if label.iter().any(|code| {
        !(alnum(Some(*code))
            || matches!(
                *code,
                0x5f | 0x24 | 0x2e | 0x5b | 0x5d | 0x3c | 0x3e | 0x3a | 0x2f | 0x20 | 0x2d
            ))
    }) {
        return false;
    }
    if !label.iter().any(|code| js_whitespace(*code)) {
        return true;
    }
    // The label holds no whitespace but spaces here, so \S+ is "no space".
    let words: Vec<&U> = label
        .split(|code| *code == 0x20)
        .filter(|word| !word.is_empty())
        .collect();
    let word = |index: usize| words.get(index).map(|word| text(word));
    // ^(?:async|new)\s+\S+$
    if words.len() == 2 && matches!(word(0).as_deref(), Some("async" | "new")) {
        return true;
    }
    // ^\S+\s+\[as\s+\S+\]$
    words.len() == 3
        && word(1).as_deref() == Some("[as")
        && word(2).is_some_and(|last| last.len() > 1 && last.ends_with(']'))
}

fn skip_async_stack_prefix(value: &U, start: usize) -> usize {
    if !starts_with_at(value, start, "async") || !ws_at(value, start + 5) {
        return start;
    }
    let mut location = start + 6;
    while location < value.len() && ws_at(value, location) {
        location += 1;
    }
    location
}

fn is_aggregate_index_location_at(value: &U, start: usize) -> bool {
    if !starts_with_at(value, start, "index") || !ws_at(value, start + 5) {
        return false;
    }
    let mut index = start + 6;
    while index < value.len() && ws_at(value, index) {
        index += 1;
    }
    if !digit(at(value, index)) {
        return false;
    }
    while index < value.len() && digit(at(value, index)) {
        index += 1;
    }
    while index < value.len() && ws_at(value, index) {
        index += 1;
    }
    at(value, index) == Some(0x29)
}

fn looks_like_stack_frame_at(value: &U, at_index: usize, allow_direct_path: bool) -> bool {
    if lower(value, at_index, at_index + 2) != "at" {
        return false;
    }
    let mut label_start = at_index + 2;
    if !ws_at(value, label_start) {
        return false;
    }
    while label_start < value.len() && ws_at(value, label_start) {
        label_start += 1;
    }
    label_start = skip_async_stack_prefix(value, label_start);
    if allow_direct_path && is_recognized_stack_path_at(value, label_start) {
        return true;
    }
    let Some(open_paren) = index_of(value, "(", label_start) else {
        return false;
    };
    if open_paren - label_start > 256 {
        return false;
    }
    let mut path_start = open_paren + 1;
    while path_start < value.len() && ws_at(value, path_start) {
        path_start += 1;
    }
    is_stack_frame_label(value, label_start, open_paren)
        && (is_recognized_stack_path_at(value, path_start)
            || (allow_direct_path && is_aggregate_index_location_at(value, path_start)))
}

fn looks_like_at_sign_stack_frame_at(value: &U, frame_start: usize) -> bool {
    let token_end = trim_path_span_end(value, frame_start, find_token_end(value, frame_start));
    let Some(at_sign) = index_of(value, "@", frame_start) else {
        return false;
    };
    if at_sign <= frame_start || at_sign >= token_end || at_sign - frame_start > 256 {
        return false;
    }
    is_stack_frame_label(value, frame_start, at_sign)
        && is_recognized_stack_path_at(value, at_sign + 1)
}

fn find_serialized_stack_frame_start(value: &U) -> Option<usize> {
    for index in 0..value.len() {
        let separator = serialized_line_separator_length_at(value, index);
        if separator == 0 {
            continue;
        }
        let mut frame_start = index + separator;
        while frame_start < value.len() {
            while frame_start < value.len() && ws_at(value, frame_start) {
                frame_start += 1;
            }
            let adjacent = serialized_line_separator_length_at(value, frame_start);
            if adjacent == 0 {
                break;
            }
            frame_start += adjacent;
        }
        if looks_like_stack_frame_at(value, frame_start, true)
            || looks_like_at_sign_stack_frame_at(value, frame_start)
        {
            let mut separator_start = index;
            while separator_start > 0 && at(value, separator_start - 1) == Some(0x5c) {
                separator_start -= 1;
            }
            return Some(separator_start);
        }
    }
    None
}

fn find_inline_stack_frame_start(value: &U) -> Option<usize> {
    let mut marker = index_of(value, " at ", 0);
    while let Some(found) = marker {
        if looks_like_stack_frame_at(value, found + 1, false) {
            return Some(found);
        }
        marker = index_of(value, " at ", found + 4);
    }
    None
}

fn find_inline_at_sign_stack_frame_start(value: &U) -> Option<usize> {
    let mut frame_start = 0;
    while frame_start < value.len() {
        if looks_like_at_sign_stack_frame_at(value, frame_start) {
            return Some(if frame_start > 0 && ws_at(value, frame_start - 1) {
                frame_start - 1
            } else {
                frame_start
            });
        }
        frame_start = find_token_end(value, frame_start);
        while frame_start < value.len() && ws_at(value, frame_start) {
            frame_start += 1;
        }
    }
    None
}

fn physical_line_separator_length_at(value: &U, start: usize) -> usize {
    let code = at(value, start);
    if !is_physical_line_separator(code) {
        return 0;
    }
    if code == Some(0x0d) && at(value, start + 1) == Some(0x0a) {
        2
    } else {
        1
    }
}

fn find_physical_stack_frame_start(value: &U) -> Option<usize> {
    let mut index = 0;
    while index < value.len() {
        let separator = physical_line_separator_length_at(value, index);
        if separator == 0 {
            index += 1;
            continue;
        }
        let mut frame_start = index + separator;
        while frame_start < value.len() && ws_at(value, frame_start) {
            frame_start += 1;
        }
        if looks_like_stack_frame_at(value, frame_start, true)
            || looks_like_at_sign_stack_frame_at(value, frame_start)
        {
            return Some(index);
        }
        index += separator;
    }
    None
}

fn strip_recognized_units(value: &U) -> Vec<u16> {
    [
        find_physical_stack_frame_start(value),
        find_serialized_stack_frame_start(value),
        find_inline_stack_frame_start(value),
        find_inline_at_sign_stack_frame_start(value),
    ]
    .into_iter()
    .flatten()
    .min()
    .map_or_else(|| value.to_vec(), |start| value[..start].to_vec())
}

/// Legacy `stripRecognizedErrorStackTail`: recognized physical, serialized
/// and inline JavaScript stack-frame tails are dropped.
pub fn strip_recognized_error_stack_tail(value: &str) -> String {
    text(&strip_recognized_units(&units(value)))
}

/// Legacy `stripErrorStackTail`: only the first physical line, without a
/// recognized stack tail.
pub fn strip_error_stack_tail(value: &str) -> String {
    let value = units(value);
    let first_line_end = (0..value.len())
        .find(|index| is_physical_line_separator(at(&value, *index)))
        .unwrap_or(value.len());
    text(&strip_recognized_units(&value[..first_line_end]))
}

/// Legacy `redactErrorPaths`: absolute filesystem paths become `<path>`,
/// while URLs, explicit API routes and surrounding punctuation stay.
pub fn redact_error_paths(value: &str) -> String {
    let value = units(value);
    let quoted = redact_quoted_absolute_paths(&value);
    let spans = redact_unquoted_absolute_path_spans(&quoted);
    // JavaScript split(/(\s+)/): tokens and whitespace runs alternate.
    let mut out = Vec::with_capacity(spans.len());
    let mut previous: Vec<u16> = Vec::new();
    let mut index = 0;
    while index < spans.len() {
        let start = index;
        let space = js_whitespace(spans[index]);
        while index < spans.len() && js_whitespace(spans[index]) == space {
            index += 1;
        }
        let part = &spans[start..index];
        if space {
            out.extend_from_slice(part);
            continue;
        }
        out.extend(redact_absolute_path_token(
            part,
            is_route_context_token(&previous),
        ));
        previous = part.to_vec();
    }
    text(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from tests/unit/error-path-redaction-route-truncation-13144.test.ts.
    #[test]
    fn routes_in_prose_keep_the_message() {
        let built = "Model 'huggingface/stabilityai/stable-diffusion-xl-base-1.0' is an image-generation model and cannot be used on /v1/chat/completions. Use POST /v1/images/generations instead.";
        let out = redact_error_paths(built);
        assert!(
            out.ends_with("Use POST /v1/images/generations instead."),
            "{out}"
        );
        assert!(out.contains(PATH), "{out}");
        for route in ["/v1/chat/completions", "/zz/chat/completions", "/v1/chat"] {
            assert_eq!(
                redact_error_paths(&format!("on {route}. Contact support.")),
                "on <path>",
                "{route}"
            );
        }
    }

    #[test]
    fn a_determinable_extension_pins_the_endpoint() {
        for (input, expected) in [
            (
                "at C:\\Program Files\\secret\\a.ts and more",
                "at <path> and more",
            ),
            (
                "failed at /Users/alice/My Project/app.ts and more",
                "failed at <path> and more",
            ),
            (
                "Provider failed in /srv/omniroute/src/private/provider.ts:42:7 with api_key='x'",
                "Provider failed in <path> with api_key='x'",
            ),
        ] {
            assert_eq!(redact_error_paths(input), expected, "{input}");
        }
        assert_eq!(
            redact_error_paths("reading /etc/shadow copy failed"),
            "reading <path>"
        );
        assert_eq!(
            redact_error_paths(
                "ENOENT: no such file or directory, open '/Users/alice/secret/app.ts'"
            ),
            "ENOENT: no such file or directory, open '<path>'"
        );
        assert_eq!(
            redact_error_paths("loading file:///Users/alice/secret/mod.ts failed later"),
            "loading <path> failed later"
        );
        assert_eq!(
            redact_error_paths("visit https://example.com/a/b now"),
            "visit https://example.com/a/b now"
        );
        assert_eq!(
            redact_error_paths("Route /v1/models is missing"),
            "Route /v1/models is missing"
        );
    }

    /// Outputs the legacy TypeScript produced for the same inputs
    /// (`error_path_redaction_oracle.json`, generated with Node).
    #[test]
    fn outputs_match_the_legacy_implementation() {
        let oracle: serde_json::Value =
            serde_json::from_str(include_str!("error_path_redaction_oracle.json")).unwrap();
        let check = |key: &str, run: fn(&str) -> String| {
            for pair in oracle[key].as_array().unwrap() {
                let input = pair[0].as_str().unwrap();
                assert_eq!(run(input), pair[1].as_str().unwrap(), "{key}: {input:?}");
            }
        };
        check("paths", redact_error_paths);
        check("recognized", strip_recognized_error_stack_tail);
        check("first", strip_error_stack_tail);
    }

    #[test]
    fn stack_tails_are_stripped() {
        assert_eq!(
            strip_error_stack_tail("TypeError: boom\n    at handler (/srv/app/src/x.ts:4:9)"),
            "TypeError: boom"
        );
        assert_eq!(
            strip_recognized_error_stack_tail("boom at handler (/srv/app/src/x.ts:4:9)"),
            "boom"
        );
        assert_eq!(
            strip_recognized_error_stack_tail("line one\nline two"),
            "line one\nline two"
        );
        assert_eq!(strip_error_stack_tail("line one\nline two"), "line one");
        assert_eq!(
            strip_recognized_error_stack_tail("failed\\n    at Object.run (node:internal/x:1:2)"),
            "failed"
        );
    }
}
