/** @type {import('next').NextConfig} */

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

const nextConfig = {
  // Allowed dev origins for local network testing (LAN, VPN, tunnel). Next.js 15+
  // blocks non-localhost dev-server requests by default as an anti DNS-rebinding measure.
  allowedDevOrigins: [
    'localhost',
    '192.168.1.0/24',
  ],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  }
};

module.exports = nextConfig;
