/**
 * Production .dockerignore Generator
 * Prevents sensitive environment secrets, local dependencies, git history, and build artifacts from leaking into images.
 */
export function generateDockerignore(metadata = {}) {
  return `node_modules
.git
.github
.env
.env.local
.env.*.local
dist
build
coverage
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
Dockerfile
docker-compose*.yml
.DS_Store
Thumbs.db
`;
}
