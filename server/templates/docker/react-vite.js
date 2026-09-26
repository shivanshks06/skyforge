/**
 * React + Vite / Vue / Svelte Production Dockerfile Generator
 * Multi-stage build: compiles static assets with Node.js and serves with optimized Nginx with SPA routing.
 */
export function generateReactViteDockerfile(metadata = {}) {
  const {
    buildCommand = "npm run build",
    port = 80,
  } = metadata;

  const runBuild = buildCommand || "npm run build";

  return `FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json yarn.lock* pnpm-lock.yaml* bun.lock* ./

RUN if [ -f bun.lock ] || [ -f bun.lockb ]; then \\
      npm install --global bun@1 && bun install --frozen-lockfile; \\
    else \\
      corepack enable && if [ -f package-lock.json ]; then \\
        npm ci --no-audit --no-fund; \\
      elif [ -f yarn.lock ]; then \\
        yarn install --frozen-lockfile; \\
      elif [ -f pnpm-lock.yaml ]; then \\
        pnpm install --frozen-lockfile; \\
      else \\
        npm install --no-audit --no-fund; \\
      fi; \\
    fi

COPY . .

RUN ${runBuild}

# Ensure output directory exists and normalize to /app/output
RUN if [ -d dist ]; then \\
      cp -R dist /app/output; \\
    elif [ -d build ]; then \\
      cp -R build /app/output; \\
    elif [ -d out ]; then \\
      cp -R out /app/output; \\
    else \\
      echo "No dist/build/out directory found" && exit 1; \\
    fi

FROM nginx:alpine

# Production SPA configuration for client-side routing
RUN echo 'server { \\
    listen 80; \\
    server_name _; \\
    root /usr/share/nginx/html; \\
    index index.html; \\
    location / { \\
        try_files $uri $uri/ /index.html; \\
    } \\
    error_page 500 502 503 504 /50x.html; \\
    location = /50x.html { \\
        root /usr/share/nginx/html; \\
    } \\
}' > /etc/nginx/conf.d/default.conf

COPY --from=builder /app/output /usr/share/nginx/html

EXPOSE ${port || 80}

CMD ["nginx", "-g", "daemon off;"]
`;
}
