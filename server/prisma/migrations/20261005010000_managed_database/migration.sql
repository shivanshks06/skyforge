-- How the app gets its database: a URL the owner provides, or an RDS instance SkyForge manages.
ALTER TABLE "Project" ADD COLUMN "databaseConfig" JSONB;
