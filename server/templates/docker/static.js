import { NGINX_SECURITY_LINES } from "./nginxSecurity.js";

/**
 * Static HTML/CSS/JavaScript Dockerfile generator.
 * Serves the directory that holds index.html (repository root, public/, docs/, ...) with Nginx.
 */
export function generateStaticDockerfile(metadata = {}) {
  const staticRoot = String(metadata.staticRoot || ".").replace(/^\.?\/*/, "") || ".";
  const source = staticRoot === "." ? "." : `${staticRoot}/`;

  return `FROM nginx:alpine

RUN printf '%s\\n' 'server {' \\
    '    listen 80;' \\
    '    server_name _;' \\
${NGINX_SECURITY_LINES}    '    root /usr/share/nginx/html;' \\
    '    index index.html index.htm;' \\
    '    location / { try_files $uri $uri/ $uri.html =404; }' \\
    '}' > /etc/nginx/conf.d/default.conf

COPY ${source} /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
`;
}
