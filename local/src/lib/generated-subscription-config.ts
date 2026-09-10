import { generateClashConfig } from "@subboost/core/generator";
import { buildGenerateOptionsFromConfig, getEffectiveTestOptions } from "@subboost/core/subscription/config-utils";
import { buildProxyProvidersFromConfig } from "@subboost/core/subscription/proxy-providers";
import type { ParsedNode } from "@subboost/core/types/node";

export function buildGeneratedSubscriptionConfig(config: Record<string, unknown>, nodes: ParsedNode[]) {
  const { testUrl, testInterval } = getEffectiveTestOptions(config);
  const proxyProviders = buildProxyProvidersFromConfig(config, { testUrl, testInterval });
  if (nodes.length === 0 && !proxyProviders) return null;
  return generateClashConfig(buildGenerateOptionsFromConfig(config, { nodes, proxyProviders }));
}
