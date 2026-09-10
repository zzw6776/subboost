export interface SubscriptionAutoUpdateState {
  externalFailureCount: number;
  failureSourceState?: string | null;
  lastFailedAt: string | null;
  lastAttemptedAt?: string | null;
  nodeQuotaFailureCount: number;
  lastNodeQuotaExceededAt: string | null;
  lastNodeQuotaActual: number | null;
  lastNodeQuotaLimit: number | null;
  disabledAt: string | null;
  disabledReason: string | null;
  disabledPreviousInterval: number | null;
}

export interface ResourceCacheEntry {
  key: string;
  name: string;
  kind: "rule-provider" | "proxy-provider" | "geodata" | "external-ui";
  sourceUrl: string;
  status: "pending" | "ready" | "stale" | "failed";
  sizeBytes: number | null;
  contentType: string | null;
  lastAttemptedAt: string | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
}

export interface ResourceCacheState {
  status: string;
  lastAttemptedAt: string | null;
  lastUpdatedAt: string | null;
  nextUpdateAt: string | null;
  lastError: string | null;
  entries: ResourceCacheEntry[];
}

export interface Subscription {
  id: string;
  name: string;
  token: string;
  subscriptionUrl: string;
  isPrimary: boolean;
  autoUpdateInterval: number | null;
  resourceCacheEnabled: boolean;
  resourceCacheInterval: number | null;
  resourceCache: ResourceCacheState;
  autoUpdateState: SubscriptionAutoUpdateState;
  smartNodeMatchingEnabled: boolean;
  lastUpdatedAt: string | null;
  lastAccessedAt: string | null;
  createdAt: string;
}

export interface RefreshSubscriptionResponse {
  error?: string;
  refreshableSourceCount?: number;
  refreshedSourceCount?: number;
  refreshedUrlSourceCount?: number;
  refreshedStaticSourceCount?: number;
  failedSourceCount?: number;
  nodeCount?: number;
  attemptedUrlFetch?: boolean;
  usedUrlFetch?: boolean;
}
