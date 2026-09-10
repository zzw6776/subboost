import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClashConfig } from "@subboost/core/types/config";

vi.mock("./prisma", () => ({ prisma: {} }));
vi.mock("./crypto", () => ({
  decryptJson: (_value: unknown, fallback: unknown) => fallback,
  decryptJsonObject: () => ({}),
  encryptJson: JSON.stringify,
}));
vi.mock("./generated-subscription-config", () => ({ buildGeneratedSubscriptionConfig: vi.fn() }));
vi.mock("./public-app-url", () => ({ getEffectivePublicAppUrl: vi.fn() }));

import {
  MIN_RESOURCE_CACHE_INTERVAL_SECONDS,
  normalizeResourceCacheInterval,
  rewriteExternalResources,
} from "./resource-cache";

describe("resource cache URL rewriting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("accepts whole-hour-or-longer cache intervals", () => {
    expect(MIN_RESOURCE_CACHE_INTERVAL_SECONDS).toBe(3600);
    expect(normalizeResourceCacheInterval("3600")).toBe(3600);
    expect(normalizeResourceCacheInterval(null)).toBeNull();
    expect(() => normalizeResourceCacheInterval(3599)).toThrow("不能少于 1 小时");
    expect(() => normalizeResourceCacheInterval(3600.5)).toThrow("不能少于 1 小时");
  });
});
