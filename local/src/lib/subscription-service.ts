import { randomBytes, randomUUID } from "node:crypto";
import { configToYaml } from "@subboost/core/generator";
import { buildGenerateOptionsFromConfig } from "@subboost/core/subscription/config-utils";
import type { SubscriptionResponseInfo } from "@subboost/core/subscription/subscription-response-info";
import type { ParsedNode } from "@subboost/core/types/node";
import {
  buildManualRefreshFailureResponse,
  buildManualRefreshSuccessResponseBody,
  createResetSubscriptionAutoUpdateState,
  normalizeSubscriptionConfigForPersistence,
  normalizeSubscriptionInfoForPersistence,
  normalizeSubscriptionName,
  normalizeSubscriptionUrlList,
  prepareRefreshCacheResult,
  refreshNodeSnapshot,
  serializeSubscriptionDetailData,
  serializeSubscriptionSummaryData,
  validateSubscriptionNodeList,
  type SavedSource,
  type RefreshNodeSnapshotResult,
} from "@subboost/server-core/subscription";
import { decryptJson, decryptJsonObject, encryptJson } from "./crypto";
import { getAppUrl } from "./env";
import { buildGeneratedSubscriptionConfig } from "./generated-subscription-config";
import { prisma } from "./prisma";
import { getEffectivePublicAppUrl } from "./public-app-url";
import {
  DEFAULT_RESOURCE_CACHE_INTERVAL_SECONDS,
  normalizeResourceCacheInterval,
  readResourceCacheEntries,
  removeSubscriptionResourceCache,
  rewriteExternalResources,
} from "./resource-cache";
import { fetchSourceUserInfoHeadersDirect, importSourceUrlDirect } from "./source-import";
import { normalizeLocalAutoUpdateIntervalSeconds } from "./auto-update-policy";

export const MAX_NODES_PER_SUBSCRIPTION = 10000;
export const CACHE_TTL_SECONDS = 3600;

export type SubscriptionRow = {
  id: string;
  ownerId: string;
  name: string;
  token: string;
  isPrimary: boolean;
  encryptedUrls: string;
  encryptedNodes: string;
  encryptedConfig: string;
  encryptedSubscriptionInfo: string | null;
  autoUpdateInterval: number | null;
  resourceCacheEnabled: boolean;
  resourceCacheInterval: number | null;
  resourceCacheStatus: string;
  resourceCacheLastAttemptedAt: Date | null;
  resourceCacheLastUpdatedAt: Date | null;
  resourceCacheLastError: string | null;
  encryptedResourceCacheEntries: string | null;
  cacheExpiresAt: Date | null;
  lastAccessedAt: Date | null;
  lastUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  autoUpdateState?: {
    externalFailureCount: number;
    failureSourceState: string | null;
    lastFailedAt: Date | null;
    lastAttemptedAt: Date | null;
    nodeQuotaFailureCount: number;
    lastNodeQuotaExceededAt: Date | null;
    lastNodeQuotaActual: number | null;
    lastNodeQuotaLimit: number | null;
    disabledAt: Date | null;
    disabledReason: string | null;
    disabledPreviousInterval: number | null;
  } | null;
};

export type SubscriptionSummary = {
  id: string;
  name: string;
  token: string;
  subscriptionUrl: string;
  nodeCount: number;
  sourceCount: number;
  yamlUrl: string;
  isPrimary: boolean;
  autoUpdateInterval: number | null;
  resourceCacheEnabled: boolean;
  resourceCacheInterval: number | null;
  resourceCache: {
    status: string;
    lastAttemptedAt: string | null;
    lastUpdatedAt: string | null;
    nextUpdateAt: string | null;
    lastError: string | null;
    entries: ReturnType<typeof readResourceCacheEntries>;
  };
  smartNodeMatchingEnabled: boolean;
  cacheExpiresAt: string | null;
  lastAccessedAt: string | null;
  lastUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  autoUpdateState: {
    externalFailureCount: number;
    lastFailedAt: string | null;
    lastAttemptedAt: string | null;
    nodeQuotaFailureCount: number;
    lastNodeQuotaExceededAt: string | null;
    lastNodeQuotaActual: number | null;
    lastNodeQuotaLimit: number | null;
    disabledAt: string | null;
    disabledReason: string | null;
    disabledPreviousInterval: number | null;
  };
};

export type SubscriptionDetail = SubscriptionSummary & {
  urls: string[];
  nodes: ParsedNode[];
  config: Record<string, unknown>;
  subscriptionInfo: Record<string, unknown>;
};

export type GeneratedSubscriptionYaml = {
  yaml: string;
  name: string;
  subscriptionInfo: SubscriptionResponseInfo;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateLocalSubscriptionNodes(value: unknown): ParsedNode[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value) && value.length > MAX_NODES_PER_SUBSCRIPTION) {
    throw new Error(`Node count cannot exceed ${MAX_NODES_PER_SUBSCRIPTION}.`);
  }
  return validateSubscriptionNodeList(value);
}

function buildLocalSubscriptionUrl(token: string, appUrl = getAppUrl()): string {
  return `${appUrl.replace(/\/+$/, "")}/api/subscriptions/${token}/config.yaml`;
}

function buildLocalSubscriptionConfig(
  body: Record<string, unknown>,
  existingConfig: Record<string, unknown> = {}
): Record<string, unknown> {
  return normalizeSubscriptionConfigForPersistence(
    {
      config: body.config,
      smartNodeMatchingEnabled: body.smartNodeMatchingEnabled,
    },
    {
      existingConfig,
      idFactory: randomUUID,
      splitUrlLines: true,
      mergeExistingConfig: false,
      defaultSmartNodeMatchingEnabled: true,
    }
  );
}

function assertNodeNameFilterKeepsOutput(
  nodes: ParsedNode[],
  config: Record<string, unknown>
): void {
  if (nodes.length === 0) return;
  const options = buildGenerateOptionsFromConfig(config, { nodes });
  const hasProxyProviders = Boolean(
    options.proxyProviders && Object.keys(options.proxyProviders).length > 0
  );
  if (options.nodes.length === 0 && !hasProxyProviders) {
    throw new Error("过滤后没有可用节点");
  }
}

export function generateLocalSubscriptionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function readSubscriptionSecrets(row: SubscriptionRow) {
  return {
    urls: decryptJson<string[]>(row.encryptedUrls, []),
    nodes: decryptJson<ParsedNode[]>(row.encryptedNodes, []),
    config: decryptJsonObject(row.encryptedConfig),
    subscriptionInfo:
      normalizeSubscriptionInfoForPersistence(decryptJson<unknown>(row.encryptedSubscriptionInfo, {})) ?? {},
  };
}

function formatResourceCache(row: SubscriptionRow) {
  const lastAttemptedAt = row.resourceCacheLastAttemptedAt?.toISOString() ?? null;
  const lastUpdatedAt = row.resourceCacheLastUpdatedAt?.toISOString() ?? null;
  const nextUpdateAt = row.resourceCacheEnabled && row.resourceCacheInterval && row.resourceCacheLastAttemptedAt
    ? new Date(row.resourceCacheLastAttemptedAt.getTime() + row.resourceCacheInterval * 1000).toISOString()
    : null;
  return {
    status: row.resourceCacheEnabled ? row.resourceCacheStatus : "disabled",
    lastAttemptedAt,
    lastUpdatedAt,
    nextUpdateAt,
    lastError: row.resourceCacheLastError,
    entries: readResourceCacheEntries(row.encryptedResourceCacheEntries),
  };
}

export function formatSubscription(row: SubscriptionRow, appUrl = getAppUrl()): SubscriptionSummary {
  const secrets = readSubscriptionSecrets(row);
  const subscriptionUrl = buildLocalSubscriptionUrl(row.token, appUrl);
  return {
    ...serializeSubscriptionSummaryData(row, secrets, {
      subscriptionUrl,
      yamlUrl: subscriptionUrl,
      dateMode: "iso",
      includeCounts: true,
      includeFailureSourceState: false,
      includeLastAttemptedAt: true,
    }),
    resourceCacheEnabled: row.resourceCacheEnabled,
    resourceCacheInterval: row.resourceCacheInterval,
    resourceCache: formatResourceCache(row),
  } as SubscriptionSummary;
}

export function formatSubscriptionDetail(row: SubscriptionRow, appUrl = getAppUrl()): SubscriptionDetail {
  const secrets = readSubscriptionSecrets(row);
  const subscriptionUrl = buildLocalSubscriptionUrl(row.token, appUrl);
  return {
    ...serializeSubscriptionDetailData(row, secrets, {
      subscriptionUrl,
      yamlUrl: subscriptionUrl,
      dateMode: "iso",
      includeCounts: true,
      includeFailureSourceState: false,
      includeLastAttemptedAt: true,
    }),
    resourceCacheEnabled: row.resourceCacheEnabled,
    resourceCacheInterval: row.resourceCacheInterval,
    resourceCache: formatResourceCache(row),
  } as SubscriptionDetail;
}

export async function listSubscriptions(ownerId: string): Promise<SubscriptionSummary[]> {
  const [rows, appUrl] = await Promise.all([
    prisma.subscription.findMany({
      where: { ownerId },
      include: { autoUpdateState: true },
      orderBy: { updatedAt: "desc" },
    }),
    getEffectivePublicAppUrl(ownerId),
  ]);
  return rows.map((row) => formatSubscription(row, appUrl));
}

export async function createSubscription(ownerId: string, body: unknown): Promise<SubscriptionSummary> {
  if (!isRecord(body)) {
    throw new Error("Invalid request body.");
  }
  const name = normalizeSubscriptionName(body.name);
  if (!name) throw new Error("Subscription name is required.");

  const urls = normalizeSubscriptionUrlList(body.urls);
  const nodes = validateLocalSubscriptionNodes(body.nodes);
  if (urls.length === 0 && nodes.length === 0) throw new Error("At least one URL or node is required.");

  const config = buildLocalSubscriptionConfig(body);
  assertNodeNameFilterKeepsOutput(nodes, config);
  const autoUpdateInterval = normalizeLocalAutoUpdateIntervalSeconds(body.autoUpdateInterval);
  const resourceCacheEnabled = body.resourceCacheEnabled === true;
  const resourceCacheInterval = resourceCacheEnabled
    ? normalizeResourceCacheInterval(body.resourceCacheInterval) ?? DEFAULT_RESOURCE_CACHE_INTERVAL_SECONDS
    : null;
  const subscriptionInfo = normalizeSubscriptionInfoForPersistence(body.subscriptionInfo) ?? {};

  const row = await prisma.subscription.create({
    data: {
      ownerId,
      name,
      token: generateLocalSubscriptionToken(),
      encryptedUrls: encryptJson(urls),
      encryptedNodes: encryptJson(nodes),
      encryptedConfig: encryptJson(config),
      encryptedSubscriptionInfo: encryptJson(subscriptionInfo),
      autoUpdateInterval,
      resourceCacheEnabled,
      resourceCacheInterval,
      resourceCacheStatus: resourceCacheEnabled ? "pending" : "disabled",
    },
    include: { autoUpdateState: true },
  });
  return formatSubscription(row, await getEffectivePublicAppUrl(ownerId));
}

export async function updateSubscription(ownerId: string, id: string, body: unknown): Promise<SubscriptionSummary | null> {
  if (!isRecord(body)) throw new Error("Invalid request body.");
  const current = await prisma.subscription.findFirst({ where: { id, ownerId }, include: { autoUpdateState: true } });
  if (!current) return null;

  const currentSecrets = readSubscriptionSecrets(current);
  const name = normalizeSubscriptionName(body.name) || current.name;
  const data: Record<string, unknown> = { name };
  const hasUrls = "urls" in body;
  const hasNodes = "nodes" in body;
  const hasConfig = "config" in body || "smartNodeMatchingEnabled" in body;
  const nextNodes = hasNodes ? validateLocalSubscriptionNodes(body.nodes) : currentSecrets.nodes;
  let nextConfig = currentSecrets.config;

  if (hasUrls) {
    data.encryptedUrls = encryptJson(normalizeSubscriptionUrlList(body.urls));
  }
  if (hasNodes) {
    data.encryptedNodes = encryptJson(nextNodes);
  }
  if (hasConfig) {
    nextConfig = buildLocalSubscriptionConfig(body, currentSecrets.config);
    data.encryptedConfig = encryptJson(nextConfig);
  }
  if ("subscriptionInfo" in body) {
    data.encryptedSubscriptionInfo = encryptJson(normalizeSubscriptionInfoForPersistence(body.subscriptionInfo) ?? {});
  }

  if (hasUrls || hasNodes || hasConfig) {
    const nextUrls = hasUrls ? normalizeSubscriptionUrlList(body.urls) : currentSecrets.urls;
    if (nextUrls.length === 0 && nextNodes.length === 0) {
      throw new Error("At least one URL or node is required.");
    }
    assertNodeNameFilterKeepsOutput(nextNodes, nextConfig);
  }

  let resetAutoUpdateState = false;
  if ("autoUpdateInterval" in body) {
    const nextAutoUpdateInterval = normalizeLocalAutoUpdateIntervalSeconds(body.autoUpdateInterval);
    data.autoUpdateInterval = nextAutoUpdateInterval;
    resetAutoUpdateState = current.autoUpdateInterval === null && nextAutoUpdateInterval !== null;
  }

  const nextResourceCacheEnabled = "resourceCacheEnabled" in body
    ? body.resourceCacheEnabled
    : current.resourceCacheEnabled;
  if (typeof nextResourceCacheEnabled !== "boolean") {
    throw new Error("resourceCacheEnabled must be a boolean");
  }

  if ("resourceCacheEnabled" in body) {
    if (typeof body.resourceCacheEnabled !== "boolean") throw new Error("resourceCacheEnabled must be a boolean");
    data.resourceCacheEnabled = body.resourceCacheEnabled;
    data.resourceCacheStatus = body.resourceCacheEnabled ? "pending" : "disabled";
    data.resourceCacheLastError = null;
    if (!body.resourceCacheEnabled) {
      data.resourceCacheInterval = null;
      data.resourceCacheLastAttemptedAt = null;
      data.resourceCacheLastUpdatedAt = null;
      data.encryptedResourceCacheEntries = null;
    }
    else if (!("resourceCacheInterval" in body) && current.resourceCacheInterval === null) {
      data.resourceCacheInterval = DEFAULT_RESOURCE_CACHE_INTERVAL_SECONDS;
    }
  }
  if ("resourceCacheInterval" in body) {
    const interval = normalizeResourceCacheInterval(body.resourceCacheInterval);
    if (nextResourceCacheEnabled && interval === null) {
      throw new Error("启用服务器资源缓存时必须设置更新间隔");
    }
    data.resourceCacheInterval = nextResourceCacheEnabled ? interval : null;
  }
  if (hasConfig && nextResourceCacheEnabled) data.resourceCacheStatus = "pending";

  const row = await prisma.$transaction(async (tx) => {
    if (resetAutoUpdateState) {
      await tx.subscriptionAutoUpdateState.upsert({
        where: { subscriptionId: current.id },
        create: { subscriptionId: current.id },
        update: createResetSubscriptionAutoUpdateState(),
      });
    }
    return tx.subscription.update({
      where: { id: current.id },
      data,
      include: { autoUpdateState: true },
    });
  });
  if (current.resourceCacheEnabled && !nextResourceCacheEnabled) {
    await removeSubscriptionResourceCache(current.id).catch(() => undefined);
  }
  return formatSubscription(row, await getEffectivePublicAppUrl(ownerId));
}

export async function getSubscription(ownerId: string, id: string): Promise<SubscriptionDetail | null> {
  const [row, appUrl] = await Promise.all([
    prisma.subscription.findFirst({
      where: { id, ownerId },
      include: { autoUpdateState: true },
    }),
    getEffectivePublicAppUrl(ownerId),
  ]);
  return row ? formatSubscriptionDetail(row, appUrl) : null;
}

export async function deleteSubscription(ownerId: string, id: string): Promise<boolean> {
  const row = await prisma.subscription.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!row) return false;
  await prisma.subscription.delete({ where: { id: row.id } });
  await removeSubscriptionResourceCache(row.id).catch(() => undefined);
  return true;
}

export function buildSubscriptionFetchCallbacks() {
  return {
    fetchUrlNodes: async (source: SavedSource) => {
      const imported = await importSourceUrlDirect({
        url: source.content,
        ...(source.userinfoUrl ? { userinfoUrl: source.userinfoUrl } : {}),
        ...(source.userinfoUserAgent ? { userinfoUserAgent: source.userinfoUserAgent } : {}),
      });
      if (imported.ok) {
        return {
          ok: true,
          nodes: imported.parsedNodes,
          errors: imported.parseErrors,
          headers: imported.headers,
        };
      }
      return {
        ok: false,
        nodes: [],
        responseStatus: imported.responseStatus,
        error: imported.error,
        errorInfo: imported.errorInfo,
        publicReason: imported.publicReason ?? undefined,
      };
    },
    fetchUrlUserInfo: async (source: SavedSource) => {
      return fetchSourceUserInfoHeadersDirect(source);
    },
  };
}

export function buildSubscriptionCacheExpiry(from: Date): Date {
  return new Date(from.getTime() + CACHE_TTL_SECONDS * 1000);
}

async function persistRefreshSuccess(params: {
  subscriptionId: string;
  expectedUpdatedAt: Date;
  snapshot: RefreshNodeSnapshotResult;
  config: Record<string, unknown>;
  cachedAt: Date;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.subscription.updateMany({
      where: { id: params.subscriptionId, updatedAt: params.expectedUpdatedAt },
      data: {
        encryptedNodes: encryptJson(params.snapshot.nodes),
        encryptedConfig: encryptJson({ ...params.config, sources: params.snapshot.savedSources }),
        encryptedSubscriptionInfo: encryptJson(params.snapshot.subscriptionInfo),
        lastUpdatedAt: params.cachedAt,
        cacheExpiresAt: buildSubscriptionCacheExpiry(params.cachedAt),
        updatedAt: params.cachedAt,
      },
    });
    if (updated.count !== 1) return false;
    await tx.subscriptionAutoUpdateState.upsert({
      where: { subscriptionId: params.subscriptionId },
      create: { subscriptionId: params.subscriptionId },
      update: createResetSubscriptionAutoUpdateState(),
    });
    return true;
  });
}

export async function refreshSubscription(ownerId: string, id: string) {
  const row = await prisma.subscription.findFirst({ where: { id, ownerId }, include: { autoUpdateState: true } });
  if (!row) return null;

  const secrets = readSubscriptionSecrets(row);
  const snapshot = await refreshNodeSnapshot({
    config: secrets.config,
    urls: secrets.urls,
    storedNodes: secrets.nodes,
    ...buildSubscriptionFetchCallbacks(),
  });
  const refreshResult = prepareRefreshCacheResult({
    config: secrets.config,
    snapshot,
    maxNodesPerSubscription: MAX_NODES_PER_SUBSCRIPTION,
  });

  if (!refreshResult.ok) {
    return {
      ok: false as const,
      response: buildManualRefreshFailureResponse({
        refreshResult,
        maxNodesPerSubscription: MAX_NODES_PER_SUBSCRIPTION,
      }),
    };
  }

  const cachedAt = new Date();
  const persisted = await persistRefreshSuccess({
    subscriptionId: row.id,
    expectedUpdatedAt: row.updatedAt,
    snapshot,
    config: secrets.config,
    cachedAt,
  });
  if (!persisted) {
    return {
      ok: false as const,
      response: {
        body: { error: "Subscription changed while refresh was in progress.", code: "SUBSCRIPTION_CHANGED" },
        status: 409,
      },
    };
  }
  return {
    ok: true as const,
    body: buildManualRefreshSuccessResponseBody({
      subscriptionId: row.id,
      refreshResult,
      snapshot,
      cachedAt,
    }),
  };
}

export async function generateSubscriptionYaml(token: string): Promise<GeneratedSubscriptionYaml | null> {
  const row = await prisma.subscription.findUnique({ where: { token }, include: { autoUpdateState: true } });
  if (!row) return null;
  const secrets = readSubscriptionSecrets(row);
  const generated = buildGeneratedSubscriptionConfig(secrets.config, secrets.nodes);
  if (!generated) return null;
  if (row.resourceCacheEnabled) {
    rewriteExternalResources(generated, row.token, await getEffectivePublicAppUrl(row.ownerId));
  }
  const yaml = configToYaml(generated);
  await prisma.subscription.update({ where: { id: row.id }, data: { lastAccessedAt: new Date() } });
  return {
    yaml,
    name: row.name,
    subscriptionInfo: secrets.subscriptionInfo,
  };
}
