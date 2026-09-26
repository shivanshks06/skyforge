-- Bind each retry to one BullMQ job so a stale worker cannot overwrite a newer run.
ALTER TABLE "Deployment"
ADD COLUMN IF NOT EXISTS "workerJobId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Deployment_workerJobId_key"
ON "Deployment" ("workerJobId");
