//! Proxy address family directives, ported from the legacy
//! `open-sse/utils/proxyFamily.ts`.

use std::net::{Ipv4Addr, Ipv6Addr};

/// Legacy `ProxyFamily`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProxyFamily {
    #[default]
    Auto,
    Ipv4,
    Ipv6,
}

/// Legacy `stripIpv6Brackets`: `[::1]` is `::1`.
pub fn strip_ipv6_brackets(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host)
}

/// Legacy `detectIpLiteralFamily` (Node `isIP`): 4 or 6 for an IP literal,
/// brackets tolerated, none for a hostname. Node's IPv6 zone suffixes
/// (`fe80::1%eth0`) are not IP literals here.
pub fn detect_ip_literal_family(host: &str) -> Option<u8> {
    let bare = strip_ipv6_brackets(host);
    if bare.parse::<Ipv4Addr>().is_ok() {
        Some(4)
    } else if bare.parse::<Ipv6Addr>().is_ok() {
        Some(6)
    } else {
        None
    }
}

/// Legacy `parseProxyFamily`: anything unknown means auto.
pub fn parse_proxy_family(value: Option<&str>) -> ProxyFamily {
    match value {
        Some("ipv4") => ProxyFamily::Ipv4,
        Some("ipv6") => ProxyFamily::Ipv6,
        _ => ProxyFamily::Auto,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from tests/unit/proxy-family.test.ts.
    #[test]
    fn proxy_hosts_and_family_directives_are_classified() {
        assert_eq!(strip_ipv6_brackets("[2001:db8::1]"), "2001:db8::1");
        assert_eq!(strip_ipv6_brackets("[::1]"), "::1");
        assert_eq!(strip_ipv6_brackets("example.com"), "example.com");
        assert_eq!(strip_ipv6_brackets("10.0.0.1"), "10.0.0.1");
        assert_eq!(detect_ip_literal_family("[2001:db8::1]"), Some(6));
        assert_eq!(detect_ip_literal_family("::1"), Some(6));
        assert_eq!(detect_ip_literal_family("203.0.113.7"), Some(4));
        assert_eq!(detect_ip_literal_family("proxy.example.com"), None);
        assert_eq!(parse_proxy_family(Some("ipv6")), ProxyFamily::Ipv6);
        assert_eq!(parse_proxy_family(Some("ipv4")), ProxyFamily::Ipv4);
        assert_eq!(parse_proxy_family(Some("auto")), ProxyFamily::Auto);
        assert_eq!(parse_proxy_family(None), ProxyFamily::Auto);
        assert_eq!(parse_proxy_family(Some("garbage")), ProxyFamily::Auto);
    }
}
