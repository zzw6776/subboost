"use client";

import * as React from "react";
import { Globe2, LogOut, Network, ServerCog, ShieldCheck } from "lucide-react";

import { Button } from "@subboost/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@subboost/ui/components/ui/card";
import { SwitchField } from "@subboost/ui/components/ui/switch-field";
import { Input } from "@subboost/ui/components/ui/input";
import { useUserStore } from "@subboost/ui/store/user-store";

export default function SettingsPage() {
  const { user, fetchUser, logout } = useUserStore();
  const [allowUnsafeSubscriptionSources, setAllowUnsafeSubscriptionSources] = React.useState(false);
  const [sourceImportLoading, setSourceImportLoading] = React.useState(true);
  const [sourceImportSaving, setSourceImportSaving] = React.useState(false);
  const [sourceImportError, setSourceImportError] = React.useState<string | null>(null);
  const [publicAppUrl, setPublicAppUrl] = React.useState("");
  const [fallbackAppUrl, setFallbackAppUrl] = React.useState("");
  const [appUrlLoading, setAppUrlLoading] = React.useState(true);
  const [appUrlSaving, setAppUrlSaving] = React.useState(false);
  const [appUrlError, setAppUrlError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void fetchUser();
  }, [fetchUser]);

  React.useEffect(() => {
    let cancelled = false;
    if (!user) {
      setSourceImportLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setSourceImportLoading(true);
    setSourceImportError(null);
    void fetch("/api/settings/source-import", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load source import settings.");
        const body = (await response.json()) as { allowUnsafeSubscriptionSources?: unknown };
        if (typeof body.allowUnsafeSubscriptionSources !== "boolean") {
          throw new Error("Invalid source import settings response.");
        }
        if (!cancelled) setAllowUnsafeSubscriptionSources(body.allowUnsafeSubscriptionSources);
      })
      .catch(() => {
        if (!cancelled) setSourceImportError("加载失败，请刷新重试");
      })
      .finally(() => {
        if (!cancelled) setSourceImportLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  React.useEffect(() => {
    let cancelled = false;
    if (!user) {
      setAppUrlLoading(false);
      return () => { cancelled = true; };
    }
    setAppUrlLoading(true);
    void fetch("/api/settings/app-url", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { publicAppUrl?: unknown; fallbackAppUrl?: unknown; error?: unknown };
        if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "加载失败");
        if (!cancelled) {
          setPublicAppUrl(typeof body.publicAppUrl === "string" ? body.publicAppUrl : "");
          setFallbackAppUrl(typeof body.fallbackAppUrl === "string" ? body.fallbackAppUrl : "");
        }
      })
      .catch((error) => {
        if (!cancelled) setAppUrlError(error instanceof Error ? error.message : "加载失败");
      })
      .finally(() => {
        if (!cancelled) setAppUrlLoading(false);
      });
    return () => { cancelled = true; };
  }, [user]);

  const savePublicAppUrl = async () => {
    setAppUrlSaving(true);
    setAppUrlError(null);
    try {
      const response = await fetch("/api/settings/app-url", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicAppUrl: publicAppUrl.trim() }),
      });
      const body = await response.json() as { publicAppUrl?: unknown; fallbackAppUrl?: unknown; error?: unknown };
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "保存失败");
      setPublicAppUrl(typeof body.publicAppUrl === "string" ? body.publicAppUrl : "");
      setFallbackAppUrl(typeof body.fallbackAppUrl === "string" ? body.fallbackAppUrl : fallbackAppUrl);
    } catch (error) {
      setAppUrlError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setAppUrlSaving(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    window.location.href = "/login";
  };

  const handleUnsafeSourceToggle = async (checked: boolean) => {
    const previousValue = allowUnsafeSubscriptionSources;
    setAllowUnsafeSubscriptionSources(checked);
    setSourceImportSaving(true);
    setSourceImportError(null);

    try {
      const response = await fetch("/api/settings/source-import", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowUnsafeSubscriptionSources: checked }),
      });
      if (!response.ok) throw new Error("Unable to save source import settings.");
      const body = (await response.json()) as { allowUnsafeSubscriptionSources?: unknown };
      if (typeof body.allowUnsafeSubscriptionSources !== "boolean") {
        throw new Error("Invalid source import settings response.");
      }
      setAllowUnsafeSubscriptionSources(body.allowUnsafeSubscriptionSources);
    } catch {
      setAllowUnsafeSubscriptionSources(previousValue);
      setSourceImportError("保存失败，请重试");
    } finally {
      setSourceImportSaving(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-1">账户设置</h1>
          <p className="text-white/50">本地管理员、订阅源安全和运行端点</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-indigo-500/20 p-2 text-indigo-300">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <CardTitle className="text-base">本地管理员</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-xs text-white/40">用户名</p>
              <p className="mt-1 font-medium">{user?.username || "未登录"}</p>
            </div>
            <div>
              <p className="text-xs text-white/40">已保存订阅</p>
              <p className="mt-1 font-medium">{user ? `${user.subscriptionCount} / ${user.quota.maxSubscriptions}` : "-"}</p>
            </div>
            <Button variant="destructive" className="gap-2" onClick={() => void handleLogout()} disabled={!user}>
              <LogOut className="h-4 w-4" />
              退出登录
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-violet-500/20 p-2 text-violet-300">
              <Globe2 className="h-5 w-5" />
            </div>
            <CardTitle className="text-base">公开访问地址</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-white/60">
              用于复制订阅链接、服务器缓存资源地址和 HTTPS Cookie。反向代理时填写外部实际访问地址。
            </p>
            <Input
              value={publicAppUrl}
              onChange={(event) => setPublicAppUrl(event.target.value)}
              placeholder={fallbackAppUrl || "https://sub.example.com"}
              disabled={!user || appUrlLoading || appUrlSaving}
            />
            <p className="text-xs text-white/40">
              留空时使用 APP_URL：{fallbackAppUrl || "-"}
            </p>
            {appUrlError && <p className="text-xs text-red-300">{appUrlError}</p>}
            <Button onClick={() => void savePublicAppUrl()} disabled={!user || appUrlLoading || appUrlSaving}>
              {appUrlSaving ? "保存中..." : "保存公开地址"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-emerald-500/20 p-2 text-emerald-300">
              <Network className="h-5 w-5" />
            </div>
            <CardTitle className="text-base">订阅源安全</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <SwitchField
              label="允许本机和局域网订阅"
              description="开启后，本机、局域网及其他保留地址都可作为订阅源。仅在信任来源时开启。"
              checked={allowUnsafeSubscriptionSources}
              disabled={!user || sourceImportLoading || sourceImportSaving}
              onCheckedChange={(checked) => void handleUnsafeSourceToggle(checked)}
            />
            {sourceImportError && <p className="text-xs text-red-300">{sourceImportError}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-sky-500/20 p-2 text-sky-300">
              <ServerCog className="h-5 w-5" />
            </div>
            <CardTitle className="text-base">运行端点</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/60">
            <div>
              <p className="text-xs text-white/40">存活检查</p>
              <code className="mt-1 block rounded-md bg-white/5 px-3 py-2 text-white/70">/api/health/live</code>
            </div>
            <div>
              <p className="text-xs text-white/40">就绪检查</p>
              <code className="mt-1 block rounded-md bg-white/5 px-3 py-2 text-white/70">/api/health/ready</code>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
