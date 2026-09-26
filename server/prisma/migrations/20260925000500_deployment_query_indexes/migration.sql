-- Index the ownership, history, and active-operation lookups used by the API.
CREATE INDEX IF NOT EXISTS "Project_userId_createdAt_idx"
ON "Project" ("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "Deployment_projectId_createdAt_idx"
ON "Deployment" ("projectId", "createdAt");

CREATE INDEX IF NOT EXISTS "Deployment_projectId_status_idx"
ON "Deployment" ("projectId", "status");
