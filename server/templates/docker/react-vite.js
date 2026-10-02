import { NODE_INSTALL_STEP, nodeImage } from "./nodeInstall.js";
import { NGINX_SECURITY_LINES } from "./nginxSecurity.js";

/**
 * Single-page app Dockerfile generator (React, Vite, Vue, Angular, Svelte, Preact, Astro static).
 * Builds with Node, then serves the first output directory containing index.html through
 * Nginx with client-side routing fallback.
 */
export function generateReactViteDockerfile(metadata = {}) {
  const {
    buildCommand = "npm run build",
    nodeVersion = "22",
    fallbackBuildCommand = "",
  } = metadata;
  const runBuild = buildCommand || "npm run build";
  const fallback = fallbackBuildCommand && fallbackBuildCommand !== runBuild ? ` || (echo "Build script failed; retrying with the bundler only (skipping type-check)..." && ${fallbackBuildCommand})` : "";

  return `FROM ${nodeImage(nodeVersion)} AS builder

WORKDIR /app

COPY . .

${NODE_INSTALL_STEP}

# Older webpack/react-scripts builds need the legacy OpenSSL provider on modern Node.
RUN ${runBuild} || NODE_OPTIONS=--openssl-legacy-provider ${runBuild}${fallback}

# Angular nests output (dist/<app>/browser); pick the shallowest directory holding index.html.
RUN OUT="$(for d in dist build out www public .output/public; do \\
      [ -d "$d" ] && find "$d" -maxdepth 3 -name index.html -printf '%d %h\\n'; \\
    done | sort -n | head -n 1 | cut -d' ' -f2-)" \\
    && if [ -z "$OUT" ]; then echo "The build did not produce an index.html (looked in dist, build, out, www, public)." >&2; exit 1; fi \\
    && cp -R "$OUT" /app/output

FROM nginx:alpine

RUN printf '%s\\n' 'server {' \\
    '    listen 80;' \\
    '    server_name _;' \\
${NGINX_SECURITY_LINES}    '    root /usr/share/nginx/html;' \\
    '    index index.html;' \\
    '    location / { try_files $uri $uri/ /index.html; }' \\
    '}' > /etc/nginx/conf.d/default.conf

COPY --from=builder /app/output /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
`;
}
