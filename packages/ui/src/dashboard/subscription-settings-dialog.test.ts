import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captures = vi.hoisted(() => ({
  buttons: [] as any[],
  inputs: [] as any[],
  switches: [] as any[],
  dialogs: [] as any[],
}));

vi.mock("@subboost/core/subscription/auto-update-interval", () => ({
  getAutoUpdateIntervalPolicyMinLabel: (policy: { minHours: number }) => `${policy.minHours} 小时`,
  resolveAutoUpdateIntervalPolicy: (isAdmin: boolean) => ({
    defaultHours: 24,
    minHours: isAdmin ? 1 : 6,
    stepHours: 1,
    requireIntegerHours: true,
  }),
}));

vi.mock("@subboost/ui/components/subscription/smart-node-matching-help", () => ({
  SmartNodeMatchingHelp: ({ enabled }: { enabled: boolean }) =>
    React.createElement("span", null, enabled ? "smart-on" : "smart-off"),
}));

vi.mock("@subboost/ui/components/ui/button", () => ({
  Button: (props: any) => {
    captures.buttons.push(props);
    return React.createElement("button", props, props.children);
  },
}));

vi.mock("@subboost/ui/components/ui/input", () => ({
  Input: (props: any) => {
    captures.inputs.push(props);
    return React.createElement("input", props);
  },
}));

vi.mock("@subboost/ui/components/ui/label", () => ({
  Label: (props: any) => React.createElement("label", props, props.children),
}));

vi.mock("@subboost/ui/components/ui/switch", () => ({
  Switch: (props: any) => {
    captures.switches.push(props);
    return React.createElement("button", {
      type: "button",
      "data-checked": String(props.checked),
      onClick: () => props.onCheckedChange?.(!props.checked),
    });
  },
}));

vi.mock("@subboost/ui/components/ui/dialog", () => ({
  Dialog: (props: any) => {
    captures.dialogs.push(props);
    return React.createElement("div", null, props.children);
  },
  DialogContent: (props: any) => React.createElement("div", props, props.children),
  DialogDescription: (props: any) => React.createElement("p", props, props.children),
  DialogFooter: (props: any) => React.createElement("footer", props, props.children),
  DialogHeader: (props: any) => React.createElement("header", props, props.children),
  DialogTitle: (props: any) => React.createElement("h2", props, props.children),
}));

import { SubscriptionSettingsDialog } from "./subscription-settings-dialog";

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  subscription: {
    id: "sub-1",
    name: "Primary",
    subscriptionUrl: "https://example.com/sub",
    isPrimary: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUpdatedAt: null,
    autoUpdateInterval: null,
    resourceCacheEnabled: false,
    resourceCacheInterval: null,
    resourceCache: {
      status: "disabled",
      lastAttemptedAt: null,
      lastUpdatedAt: null,
      nextUpdateAt: null,
      lastError: null,
      entries: [],
    },
    smartNodeMatchingEnabled: true,
    autoUpdateState: {
      externalFailureCount: 0,
      failureSourceState: null,
      lastFailedAt: null,
      lastAttemptedAt: null,
      nodeQuotaFailureCount: 0,
      lastNodeQuotaExceededAt: null,
      lastNodeQuotaActual: null,
      lastNodeQuotaLimit: null,
      disabledAt: "2026-01-02T00:00:00.000Z",
      disabledReason: "fetch_failed",
      disabledPreviousInterval: 86400,
    },
  } as any,
  settingsName: "Primary",
  setSettingsName: vi.fn(),
  smartNodeMatchingEnabled: true,
  setSmartNodeMatchingEnabled: vi.fn(),
  autoUpdateEnabled: false,
  setAutoUpdateEnabled: vi.fn(),
  autoUpdateHours: 24,
  setAutoUpdateHours: vi.fn(),
  resourceCacheEnabled: false,
  setResourceCacheEnabled: vi.fn(),
  resourceCacheHours: 24,
  setResourceCacheHours: vi.fn(),
  refreshingResourceCache: false,
  onRefreshResourceCache: vi.fn(),
  savingSettings: false,
  onSave: vi.fn(),
  userIsAdmin: false,
};

describe("SubscriptionSettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captures.buttons = [];
    captures.inputs = [];
    captures.switches = [];
    captures.dialogs = [];
  });

  it("renders disabled auto-update warning and wires basic controls", () => {
    const html = renderToStaticMarkup(React.createElement(SubscriptionSettingsDialog, baseProps));

    expect(captures.dialogs[0]).toMatchObject({ open: true });
    expect(html).toContain("订阅设置");
    expect(html).toContain("最小 6 小时");
    expect(html).toContain("自动更新已关闭：fetch_failed");
    expect(html).not.toContain("保存后首次更新");
    expect(captures.inputs[0]).toMatchObject({ value: "Primary", maxLength: 100 });
    expect(captures.switches).toHaveLength(3);

    captures.inputs[0].onChange({ target: { value: "Renamed" } });
    captures.switches[0].onCheckedChange(false);
    captures.switches[1].onCheckedChange(true);
    captures.switches[2].onCheckedChange(true);
    captures.buttons[0].onClick();
    captures.buttons[1].onClick();

    expect(baseProps.setSettingsName).toHaveBeenCalledWith("Renamed");
    expect(baseProps.setSmartNodeMatchingEnabled).toHaveBeenCalledWith(false);
    expect(baseProps.setAutoUpdateEnabled).toHaveBeenCalledWith(true);
    expect(baseProps.setResourceCacheEnabled).toHaveBeenCalledWith(true);
    expect(baseProps.onOpenChange).toHaveBeenCalledWith(false);
    expect(baseProps.onSave).toHaveBeenCalled();
  });

  it("shows cache details immediately when enabling an unsaved cache", () => {
    const html = renderToStaticMarkup(
      React.createElement(SubscriptionSettingsDialog, {
        ...baseProps,
        resourceCacheEnabled: true,
      })
    );

    expect(html).toContain("资源缓存更新间隔");
    expect(html).toContain("保存后首次更新");
    expect(html).toContain("保存后可立即更新");
    expect(captures.buttons[0]).toMatchObject({ disabled: true });
  });

  it("renders auto-update interval input and saving state", () => {
    const html = renderToStaticMarkup(
      React.createElement(SubscriptionSettingsDialog, {
        ...baseProps,
        autoUpdateEnabled: true,
        autoUpdateHours: 12,
        savingSettings: true,
        userIsAdmin: true,
      })
    );

    expect(html).toContain("最小 1 小时");
    expect(html).toContain("自动更新间隔");
    expect(captures.inputs[1]).toMatchObject({ type: "number", min: 1, value: 12 });
    expect(captures.buttons[0]).toMatchObject({ disabled: true });
    expect(captures.buttons[1]).toMatchObject({ disabled: true });

    captures.inputs[1].onChange({ target: { value: "18" } });
    expect(baseProps.setAutoUpdateHours).toHaveBeenCalledWith(18);
  });

  it("renders quota-specific recovery guidance", () => {
    const html = renderToStaticMarkup(
      React.createElement(SubscriptionSettingsDialog, {
        ...baseProps,
        subscription: {
          ...baseProps.subscription,
          autoUpdateState: {
            ...baseProps.subscription.autoUpdateState,
            nodeQuotaFailureCount: 3,
            lastNodeQuotaExceededAt: "2026-01-02T00:00:00.000Z",
            lastNodeQuotaActual: 120,
            lastNodeQuotaLimit: 100,
            disabledReason: "节点数连续超过配额",
          },
        },
      })
    );

    expect(html).toContain("实际 120，额度 100（连续 3/3 次）");
    expect(html).toContain("请减少导入节点或订阅源，或提高节点额度");
    expect(html).not.toContain("检查订阅 URL");
  });

  it("renders cache status variants, entry sizes, stale errors, and refresh state", () => {
    const entries = [
      { key: "1", name: "bytes", status: "ready", sizeBytes: 12, lastUpdatedAt: null },
      { key: "2", name: "kib", status: "stale", sizeBytes: 2048, lastUpdatedAt: "2026-01-01T00:00:00.000Z", lastError: "旧缓存" },
      { key: "3", name: "mib", status: "failed", sizeBytes: 2 * 1024 * 1024, lastUpdatedAt: null },
      { key: "4", name: "unknown", status: "custom", sizeBytes: null, lastUpdatedAt: null },
    ].map((entry) => ({
      kind: "rule-provider",
      sourceUrl: `https://example.com/${entry.key}`,
      contentType: null,
      lastAttemptedAt: null,
      lastError: null,
      ...entry,
    }));
    const html = renderToStaticMarkup(React.createElement(SubscriptionSettingsDialog, {
      ...baseProps,
      resourceCacheEnabled: true,
      refreshingResourceCache: true,
      subscription: {
        ...baseProps.subscription,
        resourceCacheEnabled: true,
        resourceCache: {
          status: "partial",
          lastAttemptedAt: null,
          lastUpdatedAt: "2026-01-01T00:00:00.000Z",
          nextUpdateAt: "2026-01-02T00:00:00.000Z",
          lastError: "一个资源失败",
          entries,
        },
      },
    }));

    expect(html).toContain("部分失败");
    expect(html).toContain("更新中...");
    expect(html).toContain("12 B");
    expect(html).toContain("2.0 KiB");
    expect(html).toContain("2.0 MiB");
    expect(html).toContain("未知大小");
    expect(html).toContain("使用旧缓存");
    expect(html).toContain("custom");
    expect(html).toContain("旧缓存");
    expect(captures.buttons[0]).toMatchObject({ disabled: true });
    captures.inputs[1].onChange({ target: { value: "48" } });
    expect(baseProps.setResourceCacheHours).toHaveBeenCalledWith(48);
  });

  it.each(["disabled", "pending", "updating", "ready", "failed", "empty"])(
    "renders the %s resource cache status label",
    (status) => {
      const html = renderToStaticMarkup(React.createElement(SubscriptionSettingsDialog, {
        ...baseProps,
        resourceCacheEnabled: true,
        subscription: {
          ...baseProps.subscription,
          resourceCacheEnabled: true,
          resourceCache: { ...baseProps.subscription.resourceCache, status },
        },
      }));
      expect(html).toContain({
        disabled: "未启用",
        pending: "等待首次更新",
        updating: "更新中",
        ready: "正常",
        failed: "更新失败",
        empty: "没有可缓存资源",
      }[status]);
      captures.buttons[0].onClick();
      expect(baseProps.onRefreshResourceCache).toHaveBeenCalled();
    }
  );

  it("renders safely without a selected subscription", () => {
    const html = renderToStaticMarkup(React.createElement(SubscriptionSettingsDialog, {
      ...baseProps,
      subscription: null,
      resourceCacheEnabled: true,
      autoUpdateEnabled: true,
    }));
    expect(html).toContain("资源缓存更新间隔");
    expect(html).not.toContain("缓存条目");
  });
});
