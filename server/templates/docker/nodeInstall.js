/**
 * Shared Node.js dependency installation step.
 * Frozen installs keep builds reproducible, but stale or foreign lockfiles are common in real
 * repositories, so each package manager falls back to a regular install instead of failing.
 */
export const NODE_INSTALL_STEP = `RUN if [ -f bun.lock ] || [ -f bun.lockb ]; then \\
      npm install --global bun@1 && (bun install --frozen-lockfile || bun install); \\
    elif [ -f pnpm-lock.yaml ]; then \\
      LOCK="$(sed -n "s/^lockfileVersion: *['\\"]\\{0,1\\}\\([0-9]*\\).*/\\1/p" pnpm-lock.yaml | head -n 1)"; \\
      case "$LOCK" in 5) PNPM=7 ;; 6) PNPM=8 ;; *) PNPM=latest ;; esac; \\
      if grep -q '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@' package.json; then corepack enable; \\
      else npm install --global --force pnpm@latest; fi; \\
      (pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile) \\
      || (npm install --global --force "pnpm@$PNPM" && (pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile)); \\
    elif [ -f yarn.lock ]; then \\
      (corepack enable && yarn install --frozen-lockfile) || (corepack enable && yarn install) || npm install --no-audit --no-fund --legacy-peer-deps; \\
    elif [ -f package-lock.json ]; then \\
      npm ci --no-audit --no-fund || npm install --no-audit --no-fund --legacy-peer-deps; \\
    else \\
      npm install --no-audit --no-fund || npm install --no-audit --no-fund --legacy-peer-deps; \\
    fi`;

// Node 14 images were never published for Debian bookworm.
export function nodeImage(version = "22") {
  const major = Number.parseInt(version, 10) || 22;
  return `node:${major}-${major < 16 ? "bullseye" : "bookworm"}-slim`;
}

export function shellQuoteForCmd(command) {
  return String(command).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
