-- Keep retries as immutable deployment attempts so a failed attempt's
-- resource manifest cannot be erased by a subsequent worker run.
ALTER TABLE "Deployment"
ADD COLUMN IF NOT EXISTS "retryOfId" TEXT;

CREATE INDEX IF NOT EXISTS "Deployment_retryOfId_idx"
ON "Deployment" ("retryOfId");
