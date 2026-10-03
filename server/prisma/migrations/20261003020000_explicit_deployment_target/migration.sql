-- Deployment targets are chosen explicitly (ECS Fargate, ECS Fargate + CloudFront, S3 + CloudFront).
ALTER TABLE "Project" ALTER COLUMN "deploymentTarget" DROP DEFAULT;

-- Projects that are not currently live must choose a target before their next deployment.
UPDATE "Project" p
SET "deploymentTarget" = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "Deployment" d
  WHERE d."projectId" = p."id" AND d."status" IN ('LIVE', 'ROLLED_BACK')
);
