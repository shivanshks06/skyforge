-- Environment variables and backing services detected from the repository source.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "envAnalysis" JSONB;
