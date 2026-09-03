// Client IP extraction for audit logging.
//
// The old implementation did:
//     req.headers["x-forwarded-for"].split(",")[0]
// i.e. it trusted the LEFTMOST X-Forwarded-For entry. That entry is whatever
// the caller put there: any client can send `X-Forwarded-For: 8.8.8.8` and the
// audit log records 8.8.8.8. Proxies only ever APPEND, so the leftmost value is
// the least trustworthy one in the chain.
//
// Express already solves this. With `app.set('trust proxy', 1)` (index.js:172)
// `req.ip` is the address the single trusted proxy actually saw, i.e. the entry
// the proxy appended rather than anything the client injected.

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^192\.0\.2\./, // TEST-NET-1
  /^198\.1[89]\./, // benchmarking
  /^198\.51\.100\./, // TEST-NET-2
  /^203\.0\.113\./, // TEST-NET-3
  /^(22[4-9]|23\d)\./, // multicast
  /^(24\d|25[0-5])\./, // reserved / broadcast
  // 100.64.0.0/10 — carrier-grade NAT. Common on mobile networks and never
  // geolocatable; the old check missed it entirely.
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** Normalize an IPv6-mapped IPv4 ("::ffff:1.2.3.4" → "1.2.3.4") and strip zones/ports. */
export function normalizeIp(ip) {
  let s = String(ip || "").trim();
  if (!s) return "";
  s = s.replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];
  // "1.2.3.4:5678" — some proxies append the source port.
  const withPort = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (withPort) return withPort[1];
  return s;
}

/** True for loopback, RFC1918, CGNAT, link-local, ULA, and other non-routable space. */
export function isPrivateIp(ip) {
  const s = normalizeIp(ip);
  if (!s) return true;
  if (s === "localhost") return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return PRIVATE_V4.some((re) => re.test(s));
  // IPv6
  const l = s.toLowerCase();
  if (l === "::" || l === "::1") return true;
  if (/^f[cd]/.test(l)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(l)) return true; // fe80::/10 link local
  if (l.startsWith("2001:db8")) return true; // documentation
  if (l.startsWith("ff")) return true; // multicast
  return false;
}

export function isPublicIp(ip) {
  const s = normalizeIp(ip);
  return Boolean(s) && !isPrivateIp(s);
}

/**
 * Best available client IP for an Express request.
 *
 * Precedence:
 *  1. TRUSTED_CLIENT_IP_HEADER, when the deployment sits behind an edge that
 *     overwrites it (e.g. `cf-connecting-ip` on Cloudflare). Opt-in only —
 *     blindly trusting CDN headers on a host that is not behind that CDN just
 *     hands spoofing back to the client.
 *  2. req.ip, resolved by Express against the `trust proxy` setting.
 *  3. The RIGHTMOST public X-Forwarded-For entry — the closest hop to us, and
 *     the last one a client cannot have forged past.
 *  4. The raw socket address.
 *
 * @param {import('express').Request} req
 * @returns {string} "" when nothing usable is present
 */
export function extractClientIp(req) {
  if (!req) return "";
  const headers = req.headers || {};

  const trustedHeader = (process.env.TRUSTED_CLIENT_IP_HEADER || "").trim().toLowerCase();
  if (trustedHeader) {
    const raw = headers[trustedHeader];
    const val = normalizeIp(Array.isArray(raw) ? raw[0] : String(raw || "").split(",")[0]);
    if (isPublicIp(val)) return val;
  }

  const fromExpress = normalizeIp(req.ip);
  if (isPublicIp(fromExpress)) return fromExpress;

  const fwdRaw = headers["x-forwarded-for"];
  const fwd = Array.isArray(fwdRaw) ? fwdRaw.join(",") : String(fwdRaw || "");
  if (fwd) {
    const hops = fwd.split(",").map(normalizeIp).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (isPublicIp(hops[i])) return hops[i];
    }
  }

  const sock = normalizeIp(req.socket?.remoteAddress);
  return fromExpress || sock || "";
}
