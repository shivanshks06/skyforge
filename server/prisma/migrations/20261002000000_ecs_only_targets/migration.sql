-- S3 + CloudFront is no longer a deployable target; every project now deploys to ECS Fargate.
UPDATE "Project"
SET "deploymentTarget" = 'AWS_ECS_FARGATE'
WHERE "deploymentTarget" IS NULL
   OR "deploymentTarget" !~* '(ECS|FARGATE)';
