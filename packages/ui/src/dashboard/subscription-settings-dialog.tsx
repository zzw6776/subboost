"use client";

import { Button } from "@subboost/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@subboost/ui/components/ui/dialog";
import { Input } from "@subboost/ui/components/ui/input";
import { FormField } from "@subboost/ui/components/ui/form-field";
import { Switch } from "@subboost/ui/components/ui/switch";
import { SwitchField } from "@subboost/ui/components/ui/switch-field";
import { SmartNodeMatchingHelp } from "@subboost/ui/components/subscription/smart-node-matching-help";
import {
  getAutoUpdateIntervalPolicyMinLabel,
  resolveAutoUpdateIntervalPolicy,
  type AutoUpdateIntervalPolicy,
} from "@subboost/core/subscription/auto-update-interval";
import type { Subscription } from "./dashboard-types";
import { formatDashboardDate } from "./dashboard-format";
import {
  buildNodeQuotaWarning,
  buildQuotaDisabledRecoveryText,
  isNodeQuotaAutoUpdateDisabled,
} from "./dashboard-auto-update-warning";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription: Subscription | null;
  settingsName: string;
  setSettingsName: (value: string) => void;
  smartNodeMatchingEnabled: boolean;
  setSmartNodeMatchingEnabled: (value: boolean) => void;
  autoUpdateEnabled: boolean;
  setAutoUpdateEnabled: (value: boolean) => void;
  autoUpdateHours: number;
  setAutoUpdateHours: (value: number) => void;
  resourceCacheEnabled: boolean;
  setResourceCacheEnabled: (value: boolean) => void;
  resourceCacheHours: number;
  setResourceCacheHours: (value: number) => void;
  refreshingResourceCache: boolean;
  onRefreshResourceCache: () => void;
  savingSettings: boolean;
  onSave: () => void;
  userIsAdmin: boolean;
  autoUpdatePolicy?: AutoUpdateIntervalPolicy;
};

export function SubscriptionSettingsDialog({
  open,
  onOpenChange,
  subscription,
  settingsName,
  setSettingsName,
  smartNodeMatchingEnabled,
  setSmartNodeMatchingEnabled,
  autoUpdateEnabled,
  setAutoUpdateEnabled,
  autoUpdateHours,
  setAutoUpdateHours,
  resourceCacheEnabled,
  setResourceCacheEnabled,
  resourceCacheHours,
  setResourceCacheHours,
  refreshingResourceCache,
  onRefreshResourceCache,
  savingSettings,
  onSave,
  userIsAdmin,
  autoUpdatePolicy,
}: Props) {
  const policy = autoUpdatePolicy ?? resolveAutoUpdateIntervalPolicy(userIsAdmin);
  const quotaWarning = subscription ? buildNodeQuotaWarning(subscription.autoUpdateState) : null;
  const quotaDisabled = subscription ? isNodeQuotaAutoUpdateDisabled(subscription.autoUpdateState) : false;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[90vh] w-[calc(100%_-_2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>订阅设置</DialogTitle>
          <DialogDescription>
            改名与自动更新配置（最小 {getAutoUpdateIntervalPolicyMinLabel(policy)}，按创建时间计时）
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto overflow-x-hidden px-6 py-2 [scrollbar-gutter:stable]">
          <FormField label="订阅名称">
            <Input
              value={settingsName}
              onChange={(e) => setSettingsName(e.target.value)}
              maxLength={100}
              placeholder="例如：我的配置"
            />
          </FormField>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm text-white/70">更新时智能匹配节点</p>
                <SmartNodeMatchingHelp enabled={smartNodeMatchingEnabled} />
              </div>
            </div>
            <Switch
              checked={smartNodeMatchingEnabled}
              onCheckedChange={setSmartNodeMatchingEnabled}
              aria-label="更新时智能匹配节点"
            />
          </div>

          <SwitchField
            label="启用自动更新"
            description="开启后服务器会按间隔刷新缓存"
            checked={autoUpdateEnabled}
            onCheckedChange={setAutoUpdateEnabled}
          />

          {!autoUpdateEnabled && subscription?.autoUpdateState.disabledAt && subscription.autoUpdateState.disabledReason && (
            <div className="rounded-md border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
              {quotaDisabled
                ? `自动更新已关闭：${buildQuotaDisabledRecoveryText(subscription.autoUpdateState)}`
                : `自动更新已关闭：${subscription.autoUpdateState.disabledReason}。当前可用配置仍会保留；检查订阅 URL 后可重新开启自动更新。`}
            </div>
          )}

          {autoUpdateEnabled && quotaWarning && (
            <div className="rounded-md border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
              {quotaWarning}。当前可用配置仍会保留；恢复到额度内后，下一次成功更新会自动清除这条警告。
            </div>
          )}

          {autoUpdateEnabled && (
            <FormField label="自动更新间隔（小时）">
              <Input
                type="number"
                min={policy.minHours}
                step={policy.stepHours}
                value={autoUpdateHours}
                onChange={(e) => setAutoUpdateHours(Number(e.target.value))}
              />
            </FormField>
          )}

          <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
            <SwitchField
              label="使用服务器资源缓存"
              description="规则集、Geo 数据和远程 Provider 由服务器下载，客户端只访问 SubBoost。"
              checked={resourceCacheEnabled}
              onCheckedChange={setResourceCacheEnabled}
            />

            {resourceCacheEnabled && (
              <FormField label="资源缓存更新间隔（小时）">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={resourceCacheHours}
                  onChange={(e) => setResourceCacheHours(Number(e.target.value))}
                />
              </FormField>
            )}

            {resourceCacheEnabled && subscription && (
              <div className="space-y-3 text-xs">
                <div className="grid gap-2 rounded-md bg-black/20 p-3 sm:grid-cols-2">
                  <p>状态：<span className="text-white/80">{subscription.resourceCacheEnabled ? resourceCacheStatusLabel(subscription.resourceCache.status) : "保存后首次更新"}</span></p>
                  <p>缓存条目：<span className="text-white/80">{subscription.resourceCacheEnabled ? subscription.resourceCache.entries.length : 0}</span></p>
                  <p>最后成功：<span className="text-white/80">{subscription.resourceCacheEnabled ? formatDashboardDate(subscription.resourceCache.lastUpdatedAt) : "—"}</span></p>
                  <p>下次更新：<span className="text-white/80">{subscription.resourceCacheEnabled ? formatDashboardDate(subscription.resourceCache.nextUpdateAt) : "—"}</span></p>
                </div>

                {subscription.resourceCache.lastError && (
                  <p className="rounded-md border border-red-400/20 bg-red-500/10 px-3 py-2 text-red-200">
                    {subscription.resourceCache.lastError}
                  </p>
                )}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onRefreshResourceCache}
                  disabled={!subscription.resourceCacheEnabled || refreshingResourceCache || savingSettings}
                >
                  {refreshingResourceCache
                    ? "更新中..."
                    : subscription.resourceCacheEnabled
                      ? "立即更新资源缓存"
                      : "保存后可立即更新"}
                </Button>

                {subscription.resourceCacheEnabled && subscription.resourceCache.entries.length > 0 && (
                  <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
                    {subscription.resourceCache.entries.map((entry) => (
                      <div key={entry.key} className="rounded-md border border-white/10 px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate font-medium text-white/80">{entry.name}</span>
                          <span className={entry.status === "ready" ? "text-emerald-300" : "text-amber-300"}>
                            {resourceCacheStatusLabel(entry.status)}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-white/40" title={entry.sourceUrl}>{entry.sourceUrl}</p>
                        <p className="mt-1 text-white/40">
                          {entry.kind} · {formatBytes(entry.sizeBytes)} · {formatDashboardDate(entry.lastUpdatedAt)}
                        </p>
                        {entry.lastError && <p className="mt-1 text-red-300">{entry.lastError}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="border-t border-white/10 px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={savingSettings}>
            取消
          </Button>
          <Button onClick={onSave} disabled={savingSettings}>
            {savingSettings ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function resourceCacheStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    disabled: "未启用",
    pending: "等待首次更新",
    updating: "更新中",
    ready: "正常",
    partial: "部分失败",
    failed: "更新失败",
    stale: "使用旧缓存",
    empty: "没有可缓存资源",
  };
  return labels[status] ?? status;
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "未知大小";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
