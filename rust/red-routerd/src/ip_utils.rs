//! Client address resolution, ported from the legacy `src/lib/ipUtils.ts`.
//!
//! Forwarding headers are trusted only behind a local reverse proxy (the TCP
//! peer is loopback); from a public socket they are attacker-controlled, and
//! per-address buckets keyed by them would be spoofable.

use axum::http::HeaderMap;

/// Node `isIP` for an address string: an IPv4 or IPv6 literal.
fn is_ip(value: &str) -> bool {
    value.parse::<std::net::IpAddr>().is_ok()
}

/// Legacy `extractClientIp`: the first valid address of a comma-separated
/// `X-Forwarded-For`, else the socket peer, else `unknown`.
pub fn extract_client_ip(x_forwarded_for: Option<&str>, remote_address: Option<&str>) -> String {
    if let Some(entries) = x_forwarded_for.filter(|value| !value.is_empty()) {
        if let Some(address) = entries
            .split(',')
            .map(str::trim)
            .find(|entry| !entry.is_empty() && is_ip(entry))
        {
            return address.to_owned();
        }
    }
    remote_address.map_or_else(|| "unknown".to_owned(), |peer| peer.trim().to_owned())
}

/// Legacy `normalizePeer`: an IPv4-mapped IPv6 peer is its IPv4 address.
fn normalize_peer(address: Option<&str>) -> &str {
    let trimmed = address.unwrap_or("").trim();
    trimmed.strip_prefix("::ffff:").unwrap_or(trimmed)
}

/// Legacy `isLoopbackPeer`.
fn is_loopback_peer(address: Option<&str>) -> bool {
    let ip = normalize_peer(address);
    !ip.is_empty() && (ip == "::1" || ip.starts_with("127."))
}

/// Legacy `IpScope`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IpScope {
    Loopback,
    Private,
    Public,
    Unknown,
}

/// Legacy `isPrivateIp`: RFC 1918, link-local, unique-local and IPv6
/// link-local prefixes.
fn is_private_ip(ip: &str) -> bool {
    if ip.starts_with("10.") || ip.starts_with("192.168.") || ip.starts_with("169.254.") {
        return true;
    }
    if let Some(rest) = ip.strip_prefix("172.") {
        if let Some(Ok(second)) = rest.split('.').next().map(str::parse::<u32>) {
            if (16..=31).contains(&second) {
                return true;
            }
        }
    }
    let lower = ip.to_ascii_lowercase();
    ["fc", "fd", "fe8", "fe9", "fea", "feb"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

/// Legacy `classifyIpScope`.
pub fn classify_ip_scope(address: Option<&str>) -> IpScope {
    let ip = normalize_peer(address);
    if ip.is_empty() {
        IpScope::Unknown
    } else if is_loopback_peer(Some(ip)) {
        IpScope::Loopback
    } else if !is_ip(ip) {
        IpScope::Unknown
    } else if is_private_ip(ip) {
        IpScope::Private
    } else {
        IpScope::Public
    }
}

/// Legacy `getClientIpFromRequest`: behind a loopback peer (or with no peer
/// known) `CF-Connecting-IP`, then `X-Forwarded-For`, then `X-Real-IP`;
/// otherwise the TCP peer itself.
pub fn client_ip_from_request(headers: &HeaderMap, remote_address: Option<&str>) -> String {
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let has_peer = !normalize_peer(remote_address).is_empty();
    if !has_peer || is_loopback_peer(remote_address) {
        if let Some(address) = header("cf-connecting-ip")
            .map(str::trim)
            .filter(|value| is_ip(value))
        {
            return address.to_owned();
        }
        return extract_client_ip(
            header("x-forwarded-for").or_else(|| header("x-real-ip")),
            remote_address,
        );
    }
    normalize_peer(remote_address).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    // Ported from tests/unit/ipUtils.test.ts.
    #[test]
    fn forwarding_headers_are_trusted_only_behind_a_loopback_peer() {
        let cases = [
            (
                &[("x-forwarded-for", "203.0.113.10")][..],
                Some("127.0.0.1"),
                "203.0.113.10",
            ),
            (
                &[("x-forwarded-for", "203.0.113.11")][..],
                Some("::1"),
                "203.0.113.11",
            ),
            (
                &[("x-real-ip", "203.0.113.12")][..],
                Some("127.0.0.1"),
                "203.0.113.12",
            ),
            (
                &[("cf-connecting-ip", "203.0.113.13")][..],
                Some("127.0.0.1"),
                "203.0.113.13",
            ),
            (
                &[("x-forwarded-for", "203.0.113.99")][..],
                Some("198.51.100.5"),
                "198.51.100.5",
            ),
            (
                &[("cf-connecting-ip", "203.0.113.88")][..],
                Some("198.51.100.7"),
                "198.51.100.7",
            ),
            (
                &[("x-forwarded-for", "203.0.113.20")][..],
                None,
                "203.0.113.20",
            ),
            (&[][..], Some("127.0.0.1"), "127.0.0.1"),
        ];
        for (pairs, peer, expected) in cases {
            assert_eq!(
                client_ip_from_request(&headers(pairs), peer),
                expected,
                "{pairs:?}"
            );
        }
        assert_eq!(
            extract_client_ip(Some("203.0.113.1, 10.0.0.1"), Some("127.0.0.1")),
            "203.0.113.1"
        );
        assert_eq!(
            extract_client_ip(None, Some("198.51.100.1")),
            "198.51.100.1"
        );
        assert_eq!(
            extract_client_ip(Some("unknown, 203.0.113.2"), Some("10.0.0.1")),
            "203.0.113.2"
        );
        assert_eq!(extract_client_ip(None, None), "unknown");
    }

    // Ported from tests/unit/8336-audit-loopback-login.test.ts.
    #[test]
    fn addresses_are_classified_by_network_scope() {
        for (address, scope) in [
            ("127.0.0.1", IpScope::Loopback),
            ("::1", IpScope::Loopback),
            ("::ffff:127.0.0.1", IpScope::Loopback),
            ("10.1.2.3", IpScope::Private),
            ("192.168.0.5", IpScope::Private),
            ("172.16.4.4", IpScope::Private),
            ("172.31.255.1", IpScope::Private),
            ("fd00::1", IpScope::Private),
            ("203.0.113.50", IpScope::Public),
            ("8.8.8.8", IpScope::Public),
            ("172.32.0.1", IpScope::Public),
            ("unknown", IpScope::Unknown),
            ("", IpScope::Unknown),
        ] {
            assert_eq!(classify_ip_scope(Some(address)), scope, "{address}");
        }
        assert_eq!(classify_ip_scope(None), IpScope::Unknown);
    }
}
