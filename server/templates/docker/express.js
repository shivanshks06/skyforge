/**
 * Express / Node.js / TypeScript Backend Dockerfile Generator
 * Lean production image with dependency fallbacks and TypeScript build support.
 */
export function generateExpressDockerfile(metadata = {}) {
  const {
    buildCommand,
    startCommand = "npm start",
    port = 5000,
  } = metadata;

  const buildStep = buildCommand
    ? `\nRUN ${buildCommand}\n`
    : "";

  return `FROM node:22-alpine

WORKDIR /app

COPY package*.json yarn.lock* pnpm-lock.yaml* bun.lock* tsconfig*.json* ./

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
${buildStep}
EXPOSE ${port || 5000}

CMD ["sh", "-c", "${(startCommand || "npm start").replace(/"/g, '\\"')}"]
`;
}
