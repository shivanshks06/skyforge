-- Auto-deploy on push, pull-request previews, custom domains, status pages, budgets, and deployment history details.
ALTER TABLE "User" ADD COLUMN "budget" JSONB;

ALTER TABLE "Project" ADD COLUMN "autoDeploy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "previewsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "parentProjectId" TEXT;
ALTER TABLE "Project" ADD COLUMN "previewPr" INTEGER;
ALTER TABLE "Project" ADD COLUMN "gitWatch" JSONB;
ALTER TABLE "Project" ADD COLUMN "customDomain" JSONB;
ALTER TABLE "Project" ADD COLUMN "statusPage" JSONB;
CREATE INDEX "Project_parentProjectId_idx" ON "Project"("parentProjectId");

ALTER TABLE "Deployment" ADD COLUMN "trigger" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "commitSha" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "commitMessage" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "commitAuthor" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "stageTimings" JSONB;
ALTER TABLE "Deployment" ADD COLUMN "restoredFromId" TEXT;

CREATE TABLE "UptimeBucket" (
    "projectId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "checks" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "latencyTotal" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "UptimeBucket_pkey" PRIMARY KEY ("projectId","hour")
);
ALTER TABLE "UptimeBucket" ADD CONSTRAINT "UptimeBucket_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
