-- Version the mutable project configuration captured by each deployment.
ALTER TABLE "Project"
ADD COLUMN IF NOT EXISTS "configVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Deployment"
ADD COLUMN IF NOT EXISTS "configVersion" INTEGER;
