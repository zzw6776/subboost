import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClashConfig } from "@subboost/core/types/config";

const mocks = vi.hoisted(() => ({
  decryptJson: vi.fn((value: unknown, fallback: unknown) => {
    if (typeof value !== "string") return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }),
  decryptJsonObject: vi.fn((value: unknown) => {
    if (typeof value !== "string") return {};
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  generated: vi.fn(),
  publicAppUrl: vi.fn(),
  lookup: vi.fn(),
  resolveHostnameByDoh: vi.fn(),
  requestPinnedBytes: vi.fn(),
  ResponseTooLargeError: class ResponseTooLargeError extends Error {},
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("./prisma", () => ({
  prisma: {
    subscription: {
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      update: mocks.update,
    },
  },
}));
vi.mock("./crypto", () => ({
  decryptJson: mocks.decryptJson,
  decryptJsonObject: mocks.decryptJsonObject,
  encryptJson: JSON.stringify,
}));
vi.mock("./generated-subscription-config", () => ({ buildGeneratedSubscriptionConfig: mocks.generated }));
vi.mock("./public-app-url", () => ({ getEffectivePublicAppUrl: mocks.publicAppUrl }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("@subboost/server-core/subscription/doh-resolver", () => ({
  resolveHostnameByDoh: mocks.resolveHostnameByDoh,
}));
vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  readFile: mocks.readFile,
  rename: mocks.rename,
  rm: mocks.rm,
  stat: mocks.stat,
  writeFile: mocks.writeFile,
}));
vi.mock("./pinned-http", () => ({
  requestPinnedBytes: mocks.requestPinnedBytes,
  ResponseTooLargeError: mocks.ResponseTooLargeError,
}));

import {
  DEFAULT_RESOURCE_CACHE_INTERVAL_SECONDS,
  MIN_RESOURCE_CACHE_INTERVAL_SECONDS,
  getResourceCacheDirectory,
  getResourceCacheFilePath,
  normalizeResourceCacheInterval,
  readCachedResource,
  readResourceCacheEntries,
  refreshSubscriptionResourceCache,
  removeSubscriptionResourceCache,
  rewriteExternalResources,
  runResourceCacheAutoUpdateCron,
} from "./resource-cache";

const baseRow = {
  id: "sub_1",
  ownerId: "owner-1",
  token: "token-1",
  encryptedNodes: "[]",
  encryptedConfig: "{}",
  resourceCacheEnabled: true,
  resourceCacheInterval: DEFAULT_RESOURCE_CACHE_INTERVAL_SECONDS,
  resourceCacheStatus: "pending",
  resourceCacheLastAttemptedAt: null,
  resourceCacheLastUpdatedAt: null,
  resourceCacheLastError: null,
  encryptedResourceCacheEntries: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("resource cache URL rewriting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RESOURCE_CACHE_DIR;
    mocks.publicAppUrl.mockResolvedValue("https://sub.example.com");
    mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    mocks.resolveHostnameByDoh.mockResolvedValue(["8.8.8.8"]);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.rename.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
    mocks.stat.mockResolvedValue({ isFile: () => true });
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.update.mockResolvedValue({});
  });

  it("rewrites every downloadable external config resource to the subscription cache endpoint", () => {
    const config = {
      "rule-providers": {
        ads: {
          type: "http",
          url: "https://raw.githubusercontent.com/example/rules/ads.mrs",
          header: { Authorization: "Bearer token" },
        },
        local: { type: "file", path: "./local.mrs" },
      },
      "proxy-providers": {
        airport: { type: "http", url: "https://example.com/sub.yaml", header: { "User-Agent": ["Clash"] } },
      },
      "geox-url": {
        geoip: "https://github.com/example/geoip.dat",
        local: "./geo.dat",
      },
      "external-ui-url": "https://github.com/example/ui.zip",
    } as unknown as ClashConfig;

    const result = rewriteExternalResources(config, "token/with space", "https://sub.example.com/");

    expect(result.descriptors).toHaveLength(4);
    expect(result.descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ads", kind: "rule-provider", requestHeaders: { Authorization: "Bearer token" } }),
      expect.objectContaining({ name: "airport", kind: "proxy-provider", requestHeaders: { "User-Agent": "Clash" } }),
      expect.objectContaining({ name: "geoip", kind: "geodata" }),
      expect.objectContaining({ name: "external-ui", kind: "external-ui" }),
    ]));

    const base = "https://sub.example.com/api/subscriptions/token%2Fwith%20space/resources/";
    const record = config as Record<string, any>;
    expect(record["rule-providers"].ads.url).toMatch(new RegExp(`^${base}`));
    expect(record["proxy-providers"].airport.url).toMatch(new RegExp(`^${base}`));
    expect(record["geox-url"].geoip).toMatch(new RegExp(`^${base}`));
    expect(record["external-ui-url"]).toMatch(new RegExp(`^${base}`));
    expect(record["rule-providers"].ads.header).toBeUndefined();
    expect(record["proxy-providers"].airport.header).toBeUndefined();
    expect(record["rule-providers"].local).toEqual({ type: "file", path: "./local.mrs" });
    expect(record["geox-url"].local).toBe("./geo.dat");
  });

  it("ignores invalid providers and applies fallback extensions and safe headers", () => {
    const config = {
      "rule-providers": {
        invalid: null,
        file: { type: "file", url: "https://example.com/file" },
        relative: { type: "http", url: "./local" },
        fallback: {
          type: "http",
          url: "https://example.com/no-extension",
          header: { Host: "blocked", "": "blank", Valid: ["one", "two"], Bad: ["one", 2] },
        },
      },
      "proxy-providers": { airport: { type: "http", url: "https://example.com/provider" } },
      "geox-url": { geo: "https://example.com/file.extensiontoolong" },
    } as unknown as ClashConfig;

    const result = rewriteExternalResources(config, "token", "https://sub.example.com////");
    expect(result.descriptors).toHaveLength(3);
    expect(result.descriptors[0]).toMatchObject({ requestHeaders: { Valid: "one, two" } });
    expect(result.descriptors[0].key).toMatch(/\.mrs$/);
    expect(result.descriptors[1].key).toMatch(/\.yaml$/);
    expect(result.descriptors[2].key).toMatch(/\.bin$/);

    const blockedHeaders = {
      "rule-providers": {
        rules: { type: "http", url: "https://example.com/rules.mrs", header: { Host: "blocked" } },
      },
    } as unknown as ClashConfig;
    expect(rewriteExternalResources(blockedHeaders, "token", "https://sub.example.com").descriptors[0].requestHeaders)
      .toBeUndefined();
  });

  it("accepts whole-hour-or-longer cache intervals", () => {
    expect(MIN_RESOURCE_CACHE_INTERVAL_SECONDS).toBe(3600);
    expect(normalizeResourceCacheInterval("3600")).toBe(3600);
    expect(normalizeResourceCacheInterval(null)).toBeNull();
    expect(() => normalizeResourceCacheInterval(3599)).toThrow("不能少于 1 小时");
    expect(() => normalizeResourceCacheInterval(3600.5)).toThrow("不能少于 1 小时");
    expect(() => normalizeResourceCacheInterval(Number.POSITIVE_INFINITY)).toThrow("不能少于 1 小时");
  });

  it("filters stored entries and validates cache paths", () => {
    const valid = { key: "a".repeat(32) + ".mrs", sourceUrl: "https://example.com/a", status: "ready" };
    expect(readResourceCacheEntries(JSON.stringify([valid, null, { key: 1 }, { key: "x", sourceUrl: 1 }])))
      .toEqual([valid]);
    expect(readResourceCacheEntries(JSON.stringify({ invalid: true }))).toEqual([]);

    process.env.RESOURCE_CACHE_DIR = "/tmp/subboost-cache";
    expect(getResourceCacheDirectory()).toBe("/tmp/subboost-cache");
    expect(getResourceCacheFilePath("sub_1", valid.key)).toBe(`/tmp/subboost-cache/sub_1/${valid.key}`);
    expect(() => getResourceCacheFilePath("sub_1", "../secret")).toThrow("Invalid cache key");
  });

  it("returns null or rejects before starting an invalid manual refresh", async () => {
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...baseRow, resourceCacheEnabled: false });

    await expect(refreshSubscriptionResourceCache("owner-1", "missing")).resolves.toBeNull();
    await expect(refreshSubscriptionResourceCache("owner-1", "sub_1")).rejects.toThrow("请先启用服务器资源缓存");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("downloads external resources and persists a successful manual refresh", async () => {
    mocks.findFirst.mockResolvedValue(baseRow);
    mocks.generated.mockReturnValue({
      "rule-providers": {
        rules: { type: "http", url: "https://rules.example.com/list.mrs", header: { Authorization: "token" } },
      },
      "geox-url": { geoip: "https://1.1.1.1/geoip.dat" },
    });
    mocks.requestPinnedBytes
      .mockResolvedValueOnce({ status: 302, headers: { location: "/final.mrs" }, content: new Uint8Array() })
      .mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        content: new Uint8Array([1, 2, 3]),
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, content: new Uint8Array([4]) });

    const result = await refreshSubscriptionResourceCache("owner-1", "sub_1");

    expect(result?.entries).toHaveLength(2);
    expect(result?.entries.every((entry) => entry.status === "ready")).toBe(true);
    expect(mocks.requestPinnedBytes).toHaveBeenCalledTimes(3);
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
    expect(mocks.rename).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      resourceCacheStatus: "ready",
      resourceCacheLastError: null,
    });
  });

  it("keeps stale files when a refresh fails and removes obsolete entries", async () => {
    const sourceUrl = "https://example.com/list.mrs";
    const previewConfig = { "rule-providers": { rules: { type: "http", url: sourceUrl } } } as unknown as ClashConfig;
    const oldKey = rewriteExternalResources(previewConfig, "token-1", "https://sub.example.com").descriptors[0].key;
    const obsoleteKey = "c".repeat(32) + ".yaml";
    const oldEntry = {
      key: oldKey,
      name: "rules",
      kind: "rule-provider",
      sourceUrl,
      status: "ready",
      sizeBytes: 42,
      contentType: "text/plain",
      lastAttemptedAt: null,
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
    };
    mocks.findFirst.mockResolvedValue({
      ...baseRow,
      encryptedResourceCacheEntries: JSON.stringify([oldEntry, { ...oldEntry, key: obsoleteKey }]),
    });
    mocks.generated.mockReturnValue({
      "rule-providers": { rules: { type: "http", url: oldEntry.sourceUrl } },
    });
    mocks.requestPinnedBytes.mockResolvedValue({ status: 503, headers: {}, content: new Uint8Array() });

    const result = await refreshSubscriptionResourceCache("owner-1", "sub_1");

    expect(result?.entries[0]).toMatchObject({ status: "stale", sizeBytes: 42, lastError: "HTTP 503" });
    expect(mocks.rm).toHaveBeenCalledWith(expect.stringContaining(obsoleteKey), { force: true });
    expect(mocks.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      resourceCacheStatus: "failed",
      resourceCacheLastError: "1/1 个资源更新失败",
    });
  });

  it("reports partial refreshes when one resource succeeds and another fails", async () => {
    mocks.findFirst.mockResolvedValue(baseRow);
    mocks.generated.mockReturnValue({
      "rule-providers": {
        ok: { type: "http", url: "https://ok.example.com/list.mrs" },
        bad: { type: "http", url: "https://bad.example.com/list.mrs" },
      },
    });
    mocks.requestPinnedBytes.mockImplementation(async ({ url }: { url: string }) => {
      if (url.includes("bad.example.com")) throw "network failed";
      return { status: 200, headers: {}, content: new Uint8Array([1]) };
    });

    const result = await refreshSubscriptionResourceCache("owner-1", "sub_1");
    expect(result?.entries.map((entry) => entry.status)).toEqual(["ready", "failed"]);
    expect(result?.entries[1].lastError).toBe("network failed");
    expect(mocks.update.mock.calls.at(-1)?.[0].data).toMatchObject({ resourceCacheStatus: "partial" });
  });

  it("rejects unsafe URLs and redirect failures without contacting private targets", async () => {
    mocks.findFirst.mockResolvedValue(baseRow);
    mocks.generated.mockReturnValue({
      "rule-providers": {
        credentials: { type: "http", url: "https://user:pass@example.com/list.mrs" },
        localhost: { type: "http", url: "http://localhost/list.mrs" },
        localDomain: { type: "http", url: "http://device.local/list.mrs" },
        privateIp: { type: "http", url: "http://127.0.0.1/list.mrs" },
        emptyDns: { type: "http", url: "https://empty.example.com/list.mrs" },
        privateDns: { type: "http", url: "https://private.example.com/list.mrs" },
        noLocation: { type: "http", url: "https://redirect.example.com/list.mrs" },
      },
    });
    mocks.lookup.mockImplementation(async (hostname: string) => {
      if (hostname === "empty.example.com") return [];
      if (hostname === "private.example.com") return [{ address: "10.0.0.1", family: 4 }];
      return [{ address: "1.1.1.1", family: 4 }];
    });
    mocks.requestPinnedBytes.mockResolvedValue({ status: 302, headers: {}, content: new Uint8Array() });

    const result = await refreshSubscriptionResourceCache("owner-1", "sub_1");
    expect(result?.entries).toHaveLength(7);
    expect(result?.entries.every((entry) => entry.status === "failed")).toBe(true);
    expect(result?.entries.map((entry) => entry.lastError)).toEqual(expect.arrayContaining([
      "资源 URL 不能包含账号或密码",
      "禁止缓存本机或内网资源",
      "资源域名解析到本机或内网地址",
      "HTTP 302 缺少重定向地址",
    ]));
  });

  it("deduplicates simultaneous refreshes for the same subscription", async () => {
    mocks.findFirst.mockResolvedValue(baseRow);
    mocks.generated.mockReturnValue({
      "rule-providers": { rules: { type: "http", url: "https://example.com/list.mrs" } },
    });
    let resolveDownload!: (value: unknown) => void;
    mocks.requestPinnedBytes.mockReturnValue(new Promise((resolve) => { resolveDownload = resolve; }));

    const first = refreshSubscriptionResourceCache("owner-1", "sub_1");
    const second = refreshSubscriptionResourceCache("owner-1", "sub_1");
    await Promise.resolve();
    await Promise.resolve();
    resolveDownload({ status: 200, headers: {}, content: new Uint8Array([1]) });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(mocks.requestPinnedBytes).toHaveBeenCalledTimes(1);
  });

  it("rechecks fake-IP DNS answers and translates oversized downloads", async () => {
    mocks.findFirst.mockResolvedValue(baseRow);
    mocks.generated.mockReturnValue({
      "rule-providers": { rules: { type: "http", url: "https://fake-ip.example.com/list.mrs" } },
    });
    mocks.lookup.mockResolvedValue([{ address: "198.18.0.1", family: 4 }]);
    mocks.requestPinnedBytes.mockRejectedValue(new mocks.ResponseTooLargeError("too large"));

    const result = await refreshSubscriptionResourceCache("owner-1", "sub_1");
    expect(mocks.resolveHostnameByDoh).toHaveBeenCalledWith("fake-ip.example.com", { timeoutMs: 4000 });
    expect(result?.entries[0]).toMatchObject({ status: "failed", lastError: "资源文件超过 64 MiB 限制" });
  });

  it("rejects redirects to unsupported protocols", async () => {
    mocks.findFirst.mockResolvedValue(baseRow);
    mocks.generated.mockReturnValue({
      "rule-providers": { rules: { type: "http", url: "https://example.com/list.mrs" } },
    });
    mocks.requestPinnedBytes.mockResolvedValue({
      status: 302,
      headers: { location: "ftp://example.com/list.mrs" },
      content: new Uint8Array(),
    });
    const result = await refreshSubscriptionResourceCache("owner-1", "sub_1");
    expect(result?.entries[0].lastError).toBe("只支持 HTTP 或 HTTPS 资源");
  });

  it("serializes non-Error refresh and cron failures", async () => {
    mocks.findFirst.mockResolvedValue(baseRow);
    mocks.generated.mockImplementationOnce(() => { throw "manual failure"; });
    await expect(refreshSubscriptionResourceCache("owner-1", "sub_1")).rejects.toBe("manual failure");
    expect(mocks.update.mock.calls.at(-1)?.[0].data.resourceCacheLastError).toBe("manual failure");

    mocks.findMany.mockResolvedValue([{ ...baseRow, resourceCacheInterval: null }]);
    mocks.generated.mockImplementationOnce(() => { throw "cron failure"; });
    await expect(runResourceCacheAutoUpdateCron(new Date("2026-01-02T00:00:00.000Z"))).resolves.toEqual({
      total: 1,
      updated: 0,
      skipped: 0,
      failed: 1,
    });
    expect(mocks.update.mock.calls.at(-1)?.[0].data.resourceCacheLastError).toBe("cron failure");
  });

  it("records a manual refresh failure when no config can be generated", async () => {
    mocks.findFirst.mockResolvedValue(baseRow);
    mocks.generated.mockReturnValue(null);

    await expect(refreshSubscriptionResourceCache("owner-1", "sub_1")).rejects.toThrow("订阅没有可生成");
    expect(mocks.update.mock.calls.at(-1)?.[0].data).toMatchObject({ resourceCacheStatus: "failed" });
  });

  it("updates only due cache rows and records cron failures", async () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    mocks.findMany.mockResolvedValue([
      { ...baseRow, id: "skip", resourceCacheStatus: "ready", resourceCacheLastAttemptedAt: now },
      { ...baseRow, id: "ok" },
      { ...baseRow, id: "fail" },
    ]);
    mocks.generated
      .mockReturnValueOnce({})
      .mockImplementationOnce(() => {
        throw new Error("generation failed");
      });

    await expect(runResourceCacheAutoUpdateCron(now)).resolves.toEqual({ total: 3, updated: 1, skipped: 1, failed: 1 });
    expect(mocks.update.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: "fail" },
      data: { resourceCacheStatus: "failed", resourceCacheLastError: "generation failed" },
    });
  });

  it("reads available cached bytes and rejects unavailable cache entries", async () => {
    const key = "d".repeat(32) + ".bin";
    const readyEntry = {
      key,
      name: "geoip",
      kind: "geodata",
      sourceUrl: "https://example.com/geoip.dat",
      status: "ready",
      sizeBytes: 3,
      contentType: null,
      lastAttemptedAt: null,
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
    };
    expect(await readCachedResource("token", "bad-key")).toBeNull();
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...baseRow, resourceCacheEnabled: false });
    expect(await readCachedResource("token", key)).toBeNull();
    expect(await readCachedResource("token", key)).toBeNull();

    mocks.findUnique.mockResolvedValue({
      ...baseRow,
      encryptedResourceCacheEntries: JSON.stringify([readyEntry]),
    });
    mocks.readFile.mockResolvedValueOnce(Buffer.from([1, 2, 3])).mockRejectedValueOnce(new Error("missing"));
    await expect(readCachedResource("token", key)).resolves.toMatchObject({
      contentType: "application/octet-stream",
      lastUpdatedAt: readyEntry.lastUpdatedAt,
    });
    await expect(readCachedResource("token", key)).resolves.toBeNull();

    mocks.findUnique.mockResolvedValue({
      ...baseRow,
      encryptedResourceCacheEntries: JSON.stringify([{ ...readyEntry, status: "failed" }]),
    });
    await expect(readCachedResource("token", key)).resolves.toBeNull();

    mocks.findUnique.mockResolvedValue({
      ...baseRow,
      encryptedResourceCacheEntries: JSON.stringify([{ ...readyEntry, status: "stale", contentType: "text/plain" }]),
    });
    mocks.readFile.mockResolvedValue(Buffer.from([4]));
    await expect(readCachedResource("token", key)).resolves.toMatchObject({ contentType: "text/plain" });
  });

  it("only removes cache directories for safe subscription ids", async () => {
    await removeSubscriptionResourceCache("../unsafe");
    expect(mocks.rm).not.toHaveBeenCalled();
    await removeSubscriptionResourceCache("safe_id-1");
    expect(mocks.rm).toHaveBeenCalledWith(expect.stringContaining("safe_id-1"), { recursive: true, force: true });
  });
});
