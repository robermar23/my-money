import type { NextConfig } from "next";

/**
 * Security response headers (P6-01/02 pre-deploy hardening).
 *
 * Applied to every route. Deliberately conservative so they don't break Plaid
 * Link (which loads scripts/frames from `cdn.plaid.com` inside an iframe *we*
 * own) or Next's inline runtime:
 *
 *   - We do NOT set a restrictive `script-src`/`frame-src` CSP — that risks
 *     breaking Plaid Link and Next hydration. A full CSP is logged as a future
 *     hardening item in docs/THREAT_MODEL.md.
 *   - We DO set the safe CSP subset that can't break those flows:
 *     `frame-ancestors 'none'` (clickjacking — nobody may frame us; Plaid is
 *     framed *by* us, not the reverse), plus `base-uri`/`form-action 'self'`.
 *   - `X-Frame-Options: DENY` duplicates `frame-ancestors` for older browsers.
 *   - HSTS is also enforced at the Cloudflare edge; setting it here is
 *     defense-in-depth and harmless over the HTTP app↔cloudflared hop.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Promoted out of `experimental` in Next 15.5.
  typedRoutes: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
