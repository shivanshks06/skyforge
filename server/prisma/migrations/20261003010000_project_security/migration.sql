-- Security tier (FREE/PROTECTED), latest security report, protection state (WAF, bans, canary),
-- and whether the site is temporarily taken offline without destroying it.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "securityTier" TEXT NOT NULL DEFAULT 'FREE';
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "securityReport" JSONB;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "protection" JSONB;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "siteOffline" BOOLEAN NOT NULL DEFAULT false;
