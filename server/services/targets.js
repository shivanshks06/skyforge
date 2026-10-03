/**
 * Deployment targets. A project has no target until its owner explicitly chooses one;
 * SkyForge never selects a target automatically.
 */
export const TARGETS = {
  ECS_FARGATE: "AWS_ECS_FARGATE",
  ECS_CLOUDFRONT: "AWS_ECS_CLOUDFRONT",
  S3_CLOUDFRONT: "AWS_S3_CLOUDFRONT",
};

export const TARGET_INFO = {
  [TARGETS.ECS_FARGATE]: {
    label: "ECS Fargate",
    summary: "Runs any app (APIs, server-rendered sites, static sites) as a container behind a load balancer.",
    https: false,
    supports: "any",
    cost: "~$27-36/month (load balancer ~$16 + 0.5 vCPU / 1 GB container ~$15)",
  },
  [TARGETS.ECS_CLOUDFRONT]: {
    label: "ECS Fargate + CloudFront",
    summary: "Same container setup with CloudFront in front: free HTTPS on a *.cloudfront.net address and global edge delivery.",
    https: true,
    supports: "any",
    cost: "~$27-36/month + CloudFront (free tier: 1 TB and 10M requests per month)",
  },
  [TARGETS.S3_CLOUDFRONT]: {
    label: "S3 + CloudFront (static)",
    summary: "Static sites and single-page apps only: files on private S3 behind CloudFront with HTTPS. No server, cheapest option.",
    https: true,
    supports: "static",
    cost: "~$0.50-2/month for small sites (S3 storage + CloudFront free tier)",
  },
};

/** Maps legacy labels and loose input to a target, or null when nothing (valid) was chosen. */
export function normalizeTarget(value) {
  const text = String(value || "").trim().toUpperCase().replace(/[\s+-]+/g, "_");
  if (!text) return null;
  if (Object.values(TARGETS).includes(text)) return text;
  if (/S3|STATIC/.test(text)) return TARGETS.S3_CLOUDFRONT;
  if (/(ECS|FARGATE).*CLOUDFRONT|CLOUDFRONT.*(ECS|FARGATE)/.test(text)) return TARGETS.ECS_CLOUDFRONT;
  if (/ECS|FARGATE/.test(text)) return TARGETS.ECS_FARGATE;
  return null;
}

export const isEcsTarget = (target) => target === TARGETS.ECS_FARGATE || target === TARGETS.ECS_CLOUDFRONT;

/** Best guess from import-time metadata; the build planner re-checks against the real source. */
export function looksStatic(project = {}) {
  const framework = String(project.framework || "").toLowerCase();
  const language = String(project.language || "").toLowerCase();
  if (/next|nuxt|remix|express|nest|fastify|django|flask|fastapi|spring|rails|laravel|go|rust|\.net/.test(framework)) return false;
  return /react|vue|angular|svelte|vite|static|html|gatsby|jekyll|astro|preact/.test(framework) || language === "html";
}
