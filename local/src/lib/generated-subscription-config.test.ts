import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  effective: vi.fn(),
  options: vi.fn(),
  providers: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("@subboost/core/generator", () => ({ generateClashConfig: mocks.generate }));
vi.mock("@subboost/core/subscription/config-utils", () => ({
  getEffectiveTestOptions: mocks.effective,
  buildGenerateOptionsFromConfig: mocks.options,
}));
vi.mock("@subboost/core/subscription/proxy-providers", () => ({
  buildProxyProvidersFromConfig: mocks.providers,
}));

import { buildGeneratedSubscriptionConfig } from "./generated-subscription-config";

describe("buildGeneratedSubscriptionConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.effective.mockReturnValue({ testUrl: "https://test.example.com", testInterval: 300 });
    mocks.options.mockReturnValue({ generated: true });
    mocks.generate.mockReturnValue({ proxies: [] });
  });

  it("returns null when there are no nodes or remote providers", () => {
    mocks.providers.mockReturnValue(null);
    expect(buildGeneratedSubscriptionConfig({}, [])).toBeNull();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it.each([
    [[{ name: "node" }], null],
    [[], { airport: { type: "http" } }],
  ])("generates a config for nodes or providers", (nodes, providers) => {
    mocks.providers.mockReturnValue(providers);
    expect(buildGeneratedSubscriptionConfig({ mixedPort: 7890 }, nodes as any)).toEqual({ proxies: [] });
    expect(mocks.options).toHaveBeenCalledWith(
      { mixedPort: 7890 },
      { nodes, proxyProviders: providers }
    );
    expect(mocks.generate).toHaveBeenCalledWith({ generated: true });
  });
});
