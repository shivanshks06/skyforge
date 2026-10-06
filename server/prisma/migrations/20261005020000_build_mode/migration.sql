-- Where the container image is built: "local" (this machine) or "cloud" (AWS CodeBuild).
ALTER TABLE "Project" ADD COLUMN "buildMode" TEXT NOT NULL DEFAULT 'local';
