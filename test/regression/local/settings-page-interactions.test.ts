import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  buttons: [] as Array<Record<string, any>>,
  cleanups: [] as Array<() => void>,
  enabled: false,
  inputs: [] as Array<Record<string, any>>,
  overrides: {} as Record<number, unknown>,
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  stateIndex: 0,
  switches: [] as Array<Record<string, any>>,
  userState: {
    fetchUser: vi.fn(),
    logout: vi.fn(),
    user: null as null | {
      username: string;
      subscriptionCount: number;
      quota: { maxSubscriptions: number };
    },
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: React.EffectCallback, deps?: React.DependencyList) => {
      if (!harness.enabled) return actual.useEffect(effect, deps);
      const cleanup = effect();
      if (typeof cleanup === "function") harness.cleanups.push(cleanup);
    },
    useState: (initial: unknown) => {
      if (!harness.enabled) return actual.useState(initial);
      const index = harness.stateIndex++;
      const value = Object.prototype.hasOwnProperty.call(harness.overrides, index)
        ? harness.overrides[index]
        : initial;
      const setter = vi.fn();
      harness.setters[index] = setter;
      return [value, setter];
    },
  };
});

vi.mock("lucide-react", () => ({
  Globe2: () => React.createElement("span", null, "globe"),
  LogOut: () => React.createElement("span", null, "logout"),
  Network: () => React.createElement("span", null, "network"),
  ServerCog: () => React.createElement("span", null, "server"),
  ShieldCheck: () => React.createElement("span", null, "shield"),
}));

vi.mock("@subboost/ui/components/ui/button", () => ({
  Button: ({ variant: _variant, ...props }: Record<string, any>) => {
    harness.buttons.push({ variant: _variant, ...props });
    return React.createElement("button", props, props.children);
  },
}));

vi.mock("@subboost/ui/components/ui/card", () => ({
  Card: (props: Record<string, any>) => React.createElement("section", props, props.children),
  CardContent: (props: Record<string, any>) => React.createElement("div", props, props.children),
  CardHeader: (props: Record<string, any>) => React.createElement("header", props, props.children),
  CardTitle: (props: Record<string, any>) => React.createElement("h2", props, props.children),
}));

vi.mock("@subboost/ui/components/ui/input", () => ({
  Input: (props: Record<string, any>) => {
    harness.inputs.push(props);
    return React.createElement("input", props);
  },
}));

vi.mock("@subboost/ui/components/ui/switch-field", () => ({
  SwitchField: (props: Record<string, any>) => {
    harness.switches.push(props);
    return React.createElement("button", {
      disabled: props.disabled,
      onClick: () => props.onCheckedChange(!props.checked),
      role: "switch",
    });
  },
}));

vi.mock("@subboost/ui/store/user-store", () => ({
  useUserStore: () => harness.userState,
}));

import SettingsPage from "../../../local/app/dashboard/settings/page";

function response(body: unknown, ok = true) {
  return {
    ok,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function renderSettings(overrides: Record<number, unknown> = {}) {
  harness.enabled = true;
  harness.overrides = overrides;
  harness.stateIndex = 0;
  harness.setters = [];
  harness.cleanups = [];
  harness.buttons = [];
  harness.inputs = [];
  harness.switches = [];
  try {
    const html = renderToStaticMarkup(React.createElement(SettingsPage));
    return {
      html,
      setters: harness.setters,
      cleanups: harness.cleanups,
      buttons: harness.buttons,
      inputs: harness.inputs,
      switches: harness.switches,
    };
  } finally {
    harness.enabled = false;
  }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("local source-import settings interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    harness.userState = {
      fetchUser: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      user: null,
    };
    vi.stubGlobal("window", { location: { href: "" } });
  });

  it("finishes immediately for an anonymous visitor and runs effect cleanup", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const view = renderSettings();

    expect(view.html).toContain("未登录");
    expect(view.setters[1]).toHaveBeenCalledWith(false);
    expect(view.switches[0]).toMatchObject({ disabled: true, checked: false });
    expect(fetchMock).not.toHaveBeenCalled();
    view.cleanups[0]();
  });

  it("loads a valid persisted value for an authenticated administrator", async () => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 2,
      quota: { maxSubscriptions: 9 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => response({ allowUnsafeSubscriptionSources: true })));

    const view = renderSettings();
    await flushPromises();

    expect(view.html).toContain("2 / 9");
    expect(view.setters[0]).toHaveBeenCalledWith(true);
    expect(view.setters[1]).toHaveBeenNthCalledWith(1, true);
    expect(view.setters[1]).toHaveBeenLastCalledWith(false);
    expect(view.setters[3]).toHaveBeenCalledWith(null);
    expect(harness.userState.fetchUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unsuccessful response", response({}, false)],
    ["a malformed response", response({ allowUnsafeSubscriptionSources: "yes" })],
  ])("shows a load error for %s", async (_label, fetchResponse) => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 0,
      quota: { maxSubscriptions: 9 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse));

    const view = renderSettings();
    await flushPromises();

    expect(view.setters[3]).toHaveBeenCalledWith("加载失败，请刷新重试");
    expect(view.setters[1]).toHaveBeenLastCalledWith(false);
  });

  it("does not update state after the settings effect is cancelled", async () => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 0,
      quota: { maxSubscriptions: 9 },
    };
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));

    const view = renderSettings();
    view.cleanups[0]();
    resolveFetch(response({ allowUnsafeSubscriptionSources: true }));
    await flushPromises();

    expect(view.setters[0]).not.toHaveBeenCalled();
    expect(view.setters[1]).toHaveBeenCalledTimes(1);
    expect(view.setters[3]).toHaveBeenCalledTimes(1);
  });

  it("suppresses source settings completion after its own request is cancelled", async () => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 0,
      quota: { maxSubscriptions: 9 },
    };
    let resolveSource!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/settings/source-import") {
        return new Promise<Response>((resolve) => { resolveSource = resolve; });
      }
      return Promise.resolve(response({ publicAppUrl: "", fallbackAppUrl: "http://internal" }));
    }));

    const view = renderSettings();
    view.cleanups[0]();
    resolveSource(response({ allowUnsafeSubscriptionSources: true }));
    await flushPromises();
    expect(view.setters[0]).not.toHaveBeenCalled();
    expect(view.setters[1]).toHaveBeenCalledTimes(1);
  });

  it("ignores a rejected settings request after cancellation", async () => {
    harness.userState.user = {
      username: "",
      subscriptionCount: 0,
      quota: { maxSubscriptions: 9 },
    };
    let rejectFetch!: (reason: Error) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
    })));

    const view = renderSettings();
    expect(view.html).toContain("未登录");
    view.cleanups[0]();
    rejectFetch(new Error("cancelled request"));
    await flushPromises();

    expect(view.setters[3]).toHaveBeenCalledTimes(1);
    expect(view.setters[1]).toHaveBeenCalledTimes(1);
  });

  it("saves a toggle and redirects after logout", async () => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 1,
      quota: { maxSubscriptions: 9 },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ allowUnsafeSubscriptionSources: false }))
      .mockResolvedValueOnce(response({ allowUnsafeSubscriptionSources: true }));
    vi.stubGlobal("fetch", fetchMock);

    const view = renderSettings();
    await flushPromises();
    view.switches[0].onCheckedChange(true);
    await flushPromises();
    view.buttons.find((button) => button.variant === "destructive")?.onClick();
    await flushPromises();

    expect(fetchMock).toHaveBeenLastCalledWith("/api/settings/source-import", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ allowUnsafeSubscriptionSources: true }),
    }));
    expect(view.setters[0]).toHaveBeenCalledWith(true);
    expect(view.setters[2]).toHaveBeenNthCalledWith(1, true);
    expect(view.setters[2]).toHaveBeenLastCalledWith(false);
    expect(window.location.href).toBe("/login");
  });

  it("loads and saves the public app URL", async () => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 1,
      quota: { maxSubscriptions: 9 },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings/source-import") return response({ allowUnsafeSubscriptionSources: false });
      if (init?.method === "PATCH") {
        return response({ publicAppUrl: "https://saved.example.com", fallbackAppUrl: "https://internal:3000" });
      }
      return response({ publicAppUrl: "https://public.example.com", fallbackAppUrl: "https://internal:3000" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderSettings({ 4: "  https://saved.example.com/  ", 5: "https://old-internal" });
    await flushPromises();
    expect(view.setters[4]).toHaveBeenCalledWith("https://public.example.com");
    expect(view.setters[5]).toHaveBeenCalledWith("https://internal:3000");
    expect(view.setters[6]).toHaveBeenNthCalledWith(1, true);
    expect(view.setters[6]).toHaveBeenLastCalledWith(false);

    view.inputs[0].onChange({ target: { value: "https://changed.example.com" } });
    expect(view.setters[4]).toHaveBeenCalledWith("https://changed.example.com");
    view.buttons.find((button) => button.children === "保存公开地址")?.onClick();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith("/api/settings/app-url", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ publicAppUrl: "https://saved.example.com/" }),
    }));
    expect(view.setters[7]).toHaveBeenNthCalledWith(1, true);
    expect(view.setters[7]).toHaveBeenLastCalledWith(false);
    expect(view.setters[8]).toHaveBeenCalledWith(null);
  });

  it("shows public URL load and save errors", async () => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 0,
      quota: { maxSubscriptions: 9 },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings/source-import") return response({ allowUnsafeSubscriptionSources: false });
      if (init?.method === "PATCH") return response({ error: "域名无效" }, false);
      return response({ error: "读取域名失败" }, false);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderSettings({ 4: "https://bad.example.com", 8: "已有错误" });
    await flushPromises();
    expect(view.html).toContain("已有错误");
    expect(view.setters[8]).toHaveBeenCalledWith("读取域名失败");

    view.buttons.find((button) => button.children === "保存公开地址")?.onClick();
    await flushPromises();
    expect(view.setters[8]).toHaveBeenCalledWith("域名无效");
    expect(view.setters[7]).toHaveBeenLastCalledWith(false);
  });

  it("handles malformed public URL data and suppresses updates after cancellation", async () => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 0,
      quota: { maxSubscriptions: 9 },
    };
    let resolveAppUrl!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/settings/source-import") {
        return Promise.resolve(response({ allowUnsafeSubscriptionSources: false }));
      }
      return new Promise<Response>((resolve) => { resolveAppUrl = resolve; });
    }));

    const view = renderSettings({ 5: "", 6: false, 7: true, 1: false, 2: true });
    expect(view.html).toContain("https://sub.example.com");
    expect(view.html).toContain("保存中...");
    expect(view.inputs[0].disabled).toBe(true);
    expect(view.switches[0].disabled).toBe(true);
    view.cleanups[1]();
    resolveAppUrl(response({ publicAppUrl: 123, fallbackAppUrl: false }));
    await flushPromises();

    expect(view.setters[4]).not.toHaveBeenCalled();
    expect(view.setters[5]).not.toHaveBeenCalled();
    expect(view.setters[6]).toHaveBeenCalledTimes(1);
  });

  it("uses fallback messages for nonstandard public URL failures", async () => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 0,
      quota: { maxSubscriptions: 9 },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings/source-import") return response({ allowUnsafeSubscriptionSources: false });
      if (init?.method === "PATCH") throw "save rejected";
      return response({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderSettings({ 4: "https://example.com" });
    await flushPromises();
    expect(view.setters[8]).toHaveBeenCalledWith("加载失败");
    view.buttons.find((button) => button.children === "保存公开地址")?.onClick();
    await flushPromises();
    expect(view.setters[8]).toHaveBeenCalledWith("保存失败");
  });

  it("normalizes malformed successful URL responses and renders source errors", async () => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 0,
      quota: { maxSubscriptions: 9 },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings/source-import") return response({ allowUnsafeSubscriptionSources: false });
      if (init?.method === "PATCH") return response({ publicAppUrl: 123, fallbackAppUrl: false });
      throw "load rejected";
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderSettings({ 3: "订阅源错误", 4: "https://example.com", 5: "https://old.example.com" });
    expect(view.html).toContain("订阅源错误");
    await flushPromises();
    expect(view.setters[8]).toHaveBeenCalledWith("加载失败");
    view.buttons.find((button) => button.children === "保存公开地址")?.onClick();
    await flushPromises();
    expect(view.setters[4]).toHaveBeenCalledWith("");
    expect(view.setters[5]).toHaveBeenCalledWith("https://old.example.com");
  });

  it.each([
    ["an unsuccessful save", response({}, false)],
    ["a malformed save", response({ allowUnsafeSubscriptionSources: "yes" })],
  ])("rolls back %s", async (_label, patchResponse) => {
    harness.userState.user = {
      username: "admin",
      subscriptionCount: 1,
      quota: { maxSubscriptions: 9 },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ allowUnsafeSubscriptionSources: true }))
      .mockResolvedValueOnce(patchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const view = renderSettings({ 0: true });
    await flushPromises();
    view.switches[0].onCheckedChange(false);
    await flushPromises();

    expect(view.setters[0]).toHaveBeenCalledWith(false);
    expect(view.setters[0]).toHaveBeenLastCalledWith(true);
    expect(view.setters[3]).toHaveBeenCalledWith("保存失败，请重试");
    expect(view.setters[2]).toHaveBeenLastCalledWith(false);
  });
});
