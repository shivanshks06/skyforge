/**
 * Security headers for SkyForge-served static sites and SPAs, as printf lines inside the nginx
 * server block: no clickjacking, no MIME sniffing, a strict referrer policy, no sensor access by
 * default, and no nginx version disclosure.
 */
export const NGINX_SECURITY_LINES = [
  "server_tokens off;",
  'add_header X-Frame-Options "SAMEORIGIN" always;',
  'add_header X-Content-Type-Options "nosniff" always;',
  'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
  'add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;',
].map((line) => `    '    ${line}' \\\n`).join("");
