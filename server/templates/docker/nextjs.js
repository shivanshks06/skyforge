export function generateNextJsDockerfile(metadata = {}) {
  const {
    buildCommand = "npm run build",
    startCommand = "npm start",
    port = 3000,
  } = metadata;
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 3000;
  const runBuild = String(buildCommand || "npm run build").replace(/"/g, '\\"');
  const runStart = String(startCommand || "npm start").replace(/"/g, '\\"');

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

# A public directory is optional in Next.js projects.
RUN mkdir -p public && ${runBuild}

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=${runtimePort}

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

EXPOSE ${runtimePort}

CMD ["sh", "-c", "${runStart}"]
`;
}
