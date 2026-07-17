"""
SSRF-hardened outbound fetch (shared guard).

Originally written for cover-art downloads (S1); factored out here so any
server-side fetch of a user-influenced or third-party URL goes through the same
checks. Every request:

  * must be https,
  * must target a host under an explicit allowlist,
  * must resolve ONLY to public, routable unicast IPs (private/loopback/
    link-local/reserved/multicast/unspecified all fail closed, so cloud-metadata
    grabs like http://169.254.169.254/… and intranet probes are blocked),
  * follows redirects manually, re-running every check on each hop (some sources,
    e.g. the Cover Art Archive, legitimately 302; we can't just disable redirects),
  * streams the body under a hard size cap.

Callers do their own content-type / payload validation on the returned bytes
(an image expects magic bytes; a JSON API expects application/json).
"""
import ipaddress
import socket
from urllib.parse import urljoin, urlsplit

import requests

import config


def host_allowed(host, allowed_hosts):
    """True if `host` equals or is a subdomain of any suffix in `allowed_hosts`."""
    host = (host or "").lower().rstrip(".")
    return any(host == h or host.endswith("." + h) for h in allowed_hosts)


def resolves_to_public(host):
    """True only if EVERY address the host resolves to is a public, routable
    unicast IP. Any private/loopback/link-local/reserved/multicast hit fails
    closed — this is what stops cloud-metadata and intranet SSRF."""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        return False
    addrs = {i[4][0] for i in infos}
    if not addrs:
        return False
    for a in addrs:
        try:
            ip = ipaddress.ip_address(a)
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return False
    return True


def check_url(url, allowed_hosts):
    """Validate one URL against scheme/host/IP policy. Returns the parsed host
    on success, raises ValueError on rejection."""
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise ValueError(f"refusing non-https URL: {parts.scheme!r}")
    host = parts.hostname
    if not host:
        raise ValueError("URL has no host")
    if not host_allowed(host, allowed_hosts):
        raise ValueError(f"host not allowlisted: {host}")
    if not resolves_to_public(host):
        raise ValueError(f"host resolves to a non-public address: {host}")
    return host


def safe_get(url, allowed_hosts, *, max_bytes, max_redirects, timeout=20):
    """SSRF-hardened GET. Returns ``(content_bytes, content_type)`` or raises
    ValueError on any policy rejection. Follows up to `max_redirects` hops,
    re-validating the URL on each one."""
    current = url
    for _ in range(max_redirects + 1):
        check_url(current, allowed_hosts)
        r = requests.get(current, headers={"User-Agent": config.USER_AGENT},
                         timeout=timeout, stream=True, allow_redirects=False)
        if r.is_redirect or r.is_permanent_redirect:
            loc = r.headers.get("Location")
            r.close()
            if not loc:
                raise ValueError("redirect without Location")
            current = urljoin(current, loc)   # resolve relative redirects
            continue
        with r:
            r.raise_for_status()
            ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
            clen = r.headers.get("Content-Length")
            if clen and int(clen) > max_bytes:
                raise ValueError("response exceeds size cap")
            chunks, total = [], 0
            for chunk in r.iter_content(64 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("response exceeds size cap")
                chunks.append(chunk)
            return b"".join(chunks), ctype
    raise ValueError("too many redirects")
