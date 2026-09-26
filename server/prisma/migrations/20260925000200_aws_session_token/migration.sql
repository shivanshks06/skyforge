-- Add support for encrypted STS session tokens on existing databases.
ALTER TABLE "AwsConnection"
ADD COLUMN IF NOT EXISTS "sessionToken" TEXT;
