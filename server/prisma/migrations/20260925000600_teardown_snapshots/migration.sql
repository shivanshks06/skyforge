-- Snapshot the exact project resources covered by a teardown operation so a
-- delayed BullMQ retry cannot tear down a newer deployment's resources.
ALTER TABLE "Deployment"
ADD COLUMN IF NOT EXISTS "teardownResources" JSONB,
ADD COLUMN IF NOT EXISTS "teardownDeploymentIds" JSONB;
