import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { lookup } from "node:dns/promises";
import type { ClashConfig } from "@subboost/core/types/config";
import type { ParsedNode } from "@subboost/core/types/node";
import { resolveHostnameByDoh } from "@subboost/server-core/subscription/doh-resolver";
import {
  isPrivateOrReservedIp,
  normalizeResolvedIpAddresses,
  selectDnsAddressesAfterFakeIpRecheck,
  shouldRecheckFakeIpDnsAnswers,
} from "@subboost/server-core/subscription/ssrf-ip";
import { decryptJson, decryptJsonObject, encryptJson } from "./crypto";
import { buildGeneratedSubscriptionConfig } from "./generated-subscription-config";
import { requestPinnedBytes, ResponseTooLargeError } from "./pinned-http";
import { getEffectivePublicAppUrl } from "./public-app-url";
import { prisma } from "./prisma";

export const DEFAULT_RESOURCE_CACHE_INTERVAL_SECONDS = 24 * 60 * 60;
export const MIN_RESOURCE_CACHE_INTERVAL_SECONDS = 60 * 60;
const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 4;
const DOWNLOAD_CONCURRENCY = 4;
const DOH_TIMEOUT_MS = 4_000;

export type ResourceCacheEntryStatus = "pending" | "ready" | "stale" | "failed";

export type ResourceCacheEntry = {
  key: string;
  name: string;
  kind: "rule-provider" | "proxy-provider" | "geodata" | "external-ui";
  sourceUrl: string;
  status: ResourceCacheEntryStatus;
  sizeBytes: number | null;
  contentType: string | null;
  lastAttemptedAt: string | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
};

type ResourceDescriptor = Pick<ResourceCacheEntry, "key" | "name" | "kind" | "sourceUrl"> & {
  requestHeaders?: Record<string, string>;
};

type ResourceCacheRow = {
  id: string;
  ownerId: string;
  token: string;
  encryptedNodes: string;
  encryptedConfig: string;
  resourceCacheEnabled: boolean;
  resourceCacheInterval: number | null;
  resourceCacheStatus: string;
  resourceCacheLastAttemptedAt: Date | null;
  resourceCacheLastUpdatedAt: Date | null;
  resourceCacheLastError: string | null;
  encryptedResourceCacheEntries: string | null;
  createdAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRequestHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  const forbidden = new Set([
    "host",
    "connection",
    "content-length",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [name, raw] of Object.entries(value)) {
    if (!name.trim() || forbidden.has(name.toLowerCase())) continue;
    if (typeof raw === "string") out[name] = raw;
    else if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) out[name] = raw.join(", ");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extensionForUrl(sourceUrl: string, kind: ResourceDescriptor["kind"]): string {
  try {
    const extension = path.extname(new URL(sourceUrl).pathname).toLowerCase();
    if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  } catch {}
  if (kind === "rule-provider") return ".mrs";
  if (kind === "proxy-provider") return ".yaml";
  return ".bin";
}

function descriptorKey(kind: ResourceDescriptor["kind"], name: string, sourceUrl: string): string {
  const digest = createHash("sha256").update(`${kind}\0${name}\0${sourceUrl}`).digest("hex").slice(0, 32);
  return `${digest}${extensionForUrl(sourceUrl, kind)}`;
}

function cacheBaseUrl(publicAppUrl: string, token: string): string {
  return `${publicAppUrl.replace(/\/+$/, "")}/api/subscriptions/${encodeURIComponent(token)}/resources`;
}

function addProviderDescriptors(params: {
  section: Record<string, unknown>;
  kind: "rule-provider" | "proxy-provider";
  baseUrl: string;
  descriptors: ResourceDescriptor[];
}) {
  for (const [name, rawProvider] of Object.entries(params.section)) {
    if (!isRecord(rawProvider) || rawProvider.type !== "http" || typeof rawProvider.url !== "string") continue;
    const sourceUrl = rawProvider.url.trim();
    if (!/^https?:\/\//i.test(sourceUrl)) continue;
    const key = descriptorKey(params.kind, name, sourceUrl);
    params.descriptors.push({
      key,
      name,
      kind: params.kind,
      sourceUrl,
      requestHeaders: normalizeRequestHeaders(rawProvider.header),
    });
    rawProvider.url = `${params.baseUrl}/${key}`;
    delete rawProvider.header;
  }
}

export function rewriteExternalResources(
  config: ClashConfig,
  token: string,
  publicAppUrl: string
): { config: ClashConfig; descriptors: ResourceDescriptor[] } {
  const record = config as unknown as Record<string, unknown>;
  const descriptors: ResourceDescriptor[] = [];
  const baseUrl = cacheBaseUrl(publicAppUrl, token);

  const ruleProviders = record["rule-providers"];
  if (isRecord(ruleProviders)) addProviderDescriptors({ section: ruleProviders, kind: "rule-provider", baseUrl, descriptors });

  const proxyProviders = record["proxy-providers"];
  if (isRecord(proxyProviders)) addProviderDescriptors({ section: proxyProviders, kind: "proxy-provider", baseUrl, descriptors });

  const geoxUrl = record["geox-url"];
  if (isRecord(geoxUrl)) {
    for (const [name, rawUrl] of Object.entries(geoxUrl)) {
      if (typeof rawUrl !== "string" || !/^https?:\/\//i.test(rawUrl.trim())) continue;
      const sourceUrl = rawUrl.trim();
      const key = descriptorKey("geodata", name, sourceUrl);
      descriptors.push({ key, name, kind: "geodata", sourceUrl });
      geoxUrl[name] = `${baseUrl}/${key}`;
    }
  }

  const externalUiUrl = record["external-ui-url"];
  if (typeof externalUiUrl === "string" && /^https?:\/\//i.test(externalUiUrl.trim())) {
    const sourceUrl = externalUiUrl.trim();
    const key = descriptorKey("external-ui", "external-ui", sourceUrl);
    descriptors.push({ key, name: "external-ui", kind: "external-ui", sourceUrl });
    record["external-ui-url"] = `${baseUrl}/${key}`;
  }

  return { config, descriptors };
}

export function readResourceCacheEntries(value: string | null | undefined): ResourceCacheEntry[] {
  const parsed = decryptJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is ResourceCacheEntry => {
    if (!isRecord(entry)) return false;
    return typeof entry.key === "string" && typeof entry.sourceUrl === "string" && typeof entry.status === "string";
  });
}

export function getResourceCacheDirectory(): string {
  return process.env.RESOURCE_CACHE_DIR?.trim() || path.join(process.cwd(), "data", "resource-cache");
}

export function getResourceCacheFilePath(subscriptionId: string, key: string): string {
  if (!/^[a-f0-9]{32}\.[a-z0-9]{1,8}$/.test(key)) throw new Error("Invalid cache key");
  return path.join(getResourceCacheDirectory(), subscriptionId, key);
}

async function validateFetchUrl(rawUrl: string): Promise<string[]> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("只支持 HTTP 或 HTTPS 资源");
  if (parsed.username || parsed.password) throw new Error("资源 URL 不能包含账号或密码");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("禁止缓存本机或内网资源");
  }
  if (isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) throw new Error("禁止缓存本机或内网资源");
    return [hostname];
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  const systemAddresses = normalizeResolvedIpAddresses(records.map((record) => record.address));
  const addresses = shouldRecheckFakeIpDnsAnswers(systemAddresses)
    ? selectDnsAddressesAfterFakeIpRecheck(
        systemAddresses,
        await resolveHostnameByDoh(hostname, { timeoutMs: DOH_TIMEOUT_MS })
      )
    : systemAddresses;
  if (addresses.length === 0 || addresses.some((address) => isPrivateOrReservedIp(address))) {
    throw new Error("资源域名解析到本机或内网地址");
  }
  return addresses;
}

async function downloadResource(descriptor: ResourceDescriptor): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let currentUrl = descriptor.sourceUrl;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const addresses = await validateFetchUrl(currentUrl);
      const response = await requestPinnedBytes({
        url: currentUrl,
        addresses,
        userAgent: "SubBoost-Resource-Cache",
        maxBytes: MAX_RESOURCE_BYTES,
        signal: controller.signal,
        requestHeaders: descriptor.requestHeaders,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location;
        if (!location) throw new Error(`HTTP ${response.status} 缺少重定向地址`);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
      return {
        bytes: response.content,
        contentType: response.headers["content-type"] || null,
      };
    }
    throw new Error("资源重定向次数过多");
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw new Error("资源文件超过 64 MiB 限制");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function replaceCacheFile(target: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function refreshResourceCacheRow(row: ResourceCacheRow): Promise<ResourceCacheEntry[]> {
  const attemptedAt = new Date();
  const config = decryptJsonObject(row.encryptedConfig);
  const nodes = decryptJson<ParsedNode[]>(row.encryptedNodes, []);
  const generated = buildGeneratedSubscriptionConfig(config, nodes);
  if (!generated) throw new Error("订阅没有可生成的节点或代理提供者");
  const publicAppUrl = await getEffectivePublicAppUrl(row.ownerId);
  const { descriptors } = rewriteExternalResources(generated, row.token, publicAppUrl);
  const previous = new Map(readResourceCacheEntries(row.encryptedResourceCacheEntries).map((entry) => [entry.key, entry]));
  const directory = path.join(getResourceCacheDirectory(), row.id);
  await mkdir(directory, { recursive: true });

  const entries = await mapConcurrent(descriptors, DOWNLOAD_CONCURRENCY, async (descriptor): Promise<ResourceCacheEntry> => {
    const old = previous.get(descriptor.key);
    try {
      const downloaded = await downloadResource(descriptor);
      const target = getResourceCacheFilePath(row.id, descriptor.key);
      await replaceCacheFile(target, downloaded.bytes);
      return {
        key: descriptor.key,
        name: descriptor.name,
        kind: descriptor.kind,
        sourceUrl: descriptor.sourceUrl,
        status: "ready",
        sizeBytes: downloaded.bytes.byteLength,
        contentType: downloaded.contentType,
        lastAttemptedAt: attemptedAt.toISOString(),
        lastUpdatedAt: attemptedAt.toISOString(),
        lastError: null,
      };
    } catch (error) {
      const hasOldFile = old
        ? await stat(getResourceCacheFilePath(row.id, descriptor.key)).then((value) => value.isFile()).catch(() => false)
        : false;
      return {
        key: descriptor.key,
        name: descriptor.name,
        kind: descriptor.kind,
        sourceUrl: descriptor.sourceUrl,
        status: hasOldFile ? "stale" : "failed",
        sizeBytes: old?.sizeBytes ?? null,
        contentType: old?.contentType ?? null,
        lastAttemptedAt: attemptedAt.toISOString(),
        lastUpdatedAt: old?.lastUpdatedAt ?? null,
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const failed = entries.filter((entry) => entry.status === "failed" || entry.status === "stale");
  const successful = entries.filter((entry) => entry.status === "ready");
  const activeKeys = new Set(entries.map((entry) => entry.key));
  await Promise.all(
    [...previous.keys()]
      .filter((key) => !activeKeys.has(key))
      .map((key) => rm(getResourceCacheFilePath(row.id, key), { force: true }).catch(() => undefined))
  );
  const status = entries.length === 0 ? "empty" : failed.length === 0 ? "ready" : successful.length > 0 ? "partial" : "failed";
  const lastError = failed.length > 0 ? `${failed.length}/${entries.length} 个资源更新失败` : null;
  await prisma.subscription.update({
    where: { id: row.id },
    data: {
      resourceCacheStatus: status,
      resourceCacheLastAttemptedAt: attemptedAt,
      ...(successful.length > 0 ? { resourceCacheLastUpdatedAt: attemptedAt } : {}),
      resourceCacheLastError: lastError,
      encryptedResourceCacheEntries: encryptJson(entries),
    },
  });
  return entries;
}

const refreshInflight = new Map<string, Promise<ResourceCacheEntry[]>>();

function runRefresh(row: ResourceCacheRow): Promise<ResourceCacheEntry[]> {
  const existing = refreshInflight.get(row.id);
  if (existing) return existing;
  const task = refreshResourceCacheRow(row).finally(() => refreshInflight.delete(row.id));
  refreshInflight.set(row.id, task);
  return task;
}

export async function refreshSubscriptionResourceCache(ownerId: string, subscriptionId: string) {
  const row = await prisma.subscription.findFirst({ where: { id: subscriptionId, ownerId } });
  if (!row) return null;
  if (!row.resourceCacheEnabled) throw new Error("请先启用服务器资源缓存");
  await prisma.subscription.update({
    where: { id: row.id },
    data: { resourceCacheStatus: "updating", resourceCacheLastAttemptedAt: new Date(), resourceCacheLastError: null },
  });
  try {
    const entries = await runRefresh(row as ResourceCacheRow);
    return { entries };
  } catch (error) {
    await prisma.subscription.update({
      where: { id: row.id },
      data: {
        resourceCacheStatus: "failed",
        resourceCacheLastAttemptedAt: new Date(),
        resourceCacheLastError: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function runResourceCacheAutoUpdateCron(now = new Date()) {
  const rows = await prisma.subscription.findMany({ where: { resourceCacheEnabled: true } });
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const raw of rows) {
    const row = raw as ResourceCacheRow;
    const interval = Math.max(row.resourceCacheInterval || DEFAULT_RESOURCE_CACHE_INTERVAL_SECONDS, MIN_RESOURCE_CACHE_INTERVAL_SECONDS);
    const anchor = row.resourceCacheLastAttemptedAt ?? row.createdAt;
    const due = row.resourceCacheStatus === "pending" || now.getTime() - anchor.getTime() >= interval * 1000;
    if (!due) {
      skipped += 1;
      continue;
    }
    try {
      await runRefresh(row);
      updated += 1;
    } catch (error) {
      failed += 1;
      await prisma.subscription.update({
        where: { id: row.id },
        data: {
          resourceCacheStatus: "failed",
          resourceCacheLastAttemptedAt: now,
          resourceCacheLastError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return { total: rows.length, updated, skipped, failed };
}

export async function readCachedResource(token: string, key: string) {
  if (!/^[a-f0-9]{32}\.[a-z0-9]{1,8}$/.test(key)) return null;
  const row = await prisma.subscription.findUnique({ where: { token } });
  if (!row || !row.resourceCacheEnabled) return null;
  const entry = readResourceCacheEntries(row.encryptedResourceCacheEntries).find((item) => item.key === key);
  if (!entry || (entry.status !== "ready" && entry.status !== "stale")) return null;
  const bytes = await readFile(getResourceCacheFilePath(row.id, key)).catch(() => null);
  if (!bytes) return null;
  return { bytes, contentType: entry.contentType || "application/octet-stream", lastUpdatedAt: entry.lastUpdatedAt };
}

export async function removeSubscriptionResourceCache(subscriptionId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(subscriptionId)) return;
  await rm(path.join(getResourceCacheDirectory(), subscriptionId), { recursive: true, force: true });
}

export function normalizeResourceCacheInterval(value: unknown): number | null {
  if (value === null || value === "" || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < MIN_RESOURCE_CACHE_INTERVAL_SECONDS) {
    throw new Error("资源缓存更新间隔不能少于 1 小时");
  }
  return parsed;
}
