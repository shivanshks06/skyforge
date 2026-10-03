-- Alert channels (per user), security incidents, and the shared attacker list.
ALTER TABLE "User" ADD COLUMN "alertSettings" JSONB;

CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "detail" JSONB,
    "actions" JSONB,
    "alerts" JSONB,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SecurityEvent_projectId_createdAt_idx" ON "SecurityEvent"("projectId", "createdAt");
CREATE INDEX "SecurityEvent_projectId_dedupeKey_idx" ON "SecurityEvent"("projectId", "dedupeKey");
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ThreatIntel" (
    "ip" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "projectIds" TEXT[],
    "reasons" TEXT[],
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ThreatIntel_pkey" PRIMARY KEY ("ip")
);
CREATE INDEX "ThreatIntel_lastSeen_idx" ON "ThreatIntel"("lastSeen");
