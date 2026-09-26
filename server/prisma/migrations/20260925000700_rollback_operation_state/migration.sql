-- Persist the state a rollback must restore if a worker retry fails.
ALTER TABLE "Deployment"
ADD COLUMN IF NOT EXISTS "rollbackOriginalStatus" TEXT;
