ALTER TABLE "LocalAdmin"
  ADD COLUMN "publicAppUrl" TEXT;

ALTER TABLE "Subscription"
  ADD COLUMN "resourceCacheEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "resourceCacheInterval" INTEGER,
  ADD COLUMN "resourceCacheStatus" TEXT NOT NULL DEFAULT 'disabled',
  ADD COLUMN "resourceCacheLastAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "resourceCacheLastUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "resourceCacheLastError" TEXT,
  ADD COLUMN "encryptedResourceCacheEntries" TEXT;

CREATE INDEX "Subscription_resourceCacheEnabled_idx"
  ON "Subscription"("resourceCacheEnabled");
