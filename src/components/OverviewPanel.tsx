import {
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Globe,
  Globe2,
  LayoutGrid,
  Loader2,
  Power,
  Rocket,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import type {
  AppId,
  AppMode,
  AppSnapshot,
  AppUpdateStatus,
  DashboardPayload,
  EdgeOneSiteRecord,
  EdgeOneStatus,
  ExtensionsSummary,
  InstallProgressEvent,
  UiPatchProgressEvent,
} from "../lib/api";
import { AppBrandIcon } from "./BrandIcons";
import type { McpToolKey } from "./McpInlineTheater";
import {
  APP_DISPLAY_NAMES,
  CLIENT_ORDER,
  formatVersion,
  installStageLabel,
  type ExtensionTab,
  type NavRoute,
} from "./UiPrimitives";

interface SelfUpdateSummary {
  status: "idle" | "checking" | "latest" | "available" | "downloading" | "installing" | "error";
  version?: string;
  source?: string;
  percent?: number;
}

interface OverviewPanelProps {
  dashboard: DashboardPayload | null;
  loading: boolean;
  updatesMap: Partial<Record<AppId, AppUpdateStatus>>;
  installProgress: Partial<Record<AppId, InstallProgressEvent>>;
  needsRestart: Partial<Record<AppId, boolean>>;
  busyApp: AppId | null;
  cancellingApp: AppId | null;
  togglingChineseUi: boolean;
  uiPatchProgress: UiPatchProgressEvent | null;
  savingMcp: boolean;
  mcpEnabledCount: number;
  mcpTotalCount: number;
  selfUpdateSummary: SelfUpdateSummary;
  onNavigate: (route: NavRoute) => void;
  onOpenMcpDetail: (tab?: McpToolKey) => void;
  edgeOneStatus?: EdgeOneStatus | null;
  edgeOneSites?: EdgeOneSiteRecord[];
  onOpenWebPage: (autoDeploy?: boolean) => void;
  extensionsSummary: ExtensionsSummary | null;
  onOpenExtensions: (tab?: ExtensionTab) => void;
  onSetMode: (app: AppSnapshot, mode: AppMode) => void;
  onLaunchApp: (appId: AppId) => void;
  onRestartApp: (appId: AppId) => void;
  onCloseApp: (appId: AppId) => void;
  onInstallOrUpgrade: (appId: AppId) => void;
  onCancelInstall: (appId: AppId) => void;
  onToggleMainChineseUi: () => void;
  onToggleCoreMcp: (key: McpToolKey) => void;
  onToggleWebPageMcp: (next: boolean) => void;
  onOpenModelSquare: () => void;
  onInstallSelfUpdate: () => void;
  onOpenChangelog: () => void;
}

const MODE_OPTIONS: { id: AppMode; label: string }[] = [
  { id: "official", label: "官方" },
  { id: "tako", label: "Tako" },
];

function briefClientSummary(
  app: AppSnapshot,
  update?: AppUpdateStatus,
  pendingAutoTako?: boolean,
): string {
  if (!app.install.installed) return "本机尚未安装 · 点击右侧安装或进设置查看引导";
  const parts: string[] = [];
  if (pendingAutoTako) {
    if (app.id === "dsh-tako") {
      parts.push(app.running ? "独立账号运行中 · 重启时自动同步" : "默认同步账号 · 启动时自动切换");
    } else {
      parts.push(app.running ? "官方运行中 · 重启时自动切至 Tako" : "默认 Tako · 启动时自动切换");
    }
  } else if (app.id === "dsh-tako") {
    parts.push(app.mode === "tako" ? "已同步当前账号密钥" : "使用独立账号登录");
  } else if (app.id === "workbuddy") {
    parts.push(
      app.mode === "tako" ? "已接入 Tako 网关 · 自动默认选中主力模型" : "官方原版直连",
    );
  } else {
    parts.push(app.mode === "tako" ? "免官方登录直连 Tako" : "官方原版直连");
  }
  if (app.id === "claude" || app.id === "antigravity") {
    if (app.uiPatch.status === "patched") {
      parts.push("界面简体中文已开启");
    } else if (app.uiPatch.status === "outdated_after_upgrade") {
      parts.push("升级后需重新汉化");
    }
  } else if (app.id === "codex" && app.chineseConfigured) {
    parts.push("中文回复已配置");
  }
  if (update?.hasUpdate && update.remoteVersion) {
    parts.push(`可升级 ${formatVersion(update.remoteVersion)}`);
  }
  return parts.join(" · ");
}

export function OverviewPanel({
  dashboard,
  loading,
  updatesMap,
  installProgress,
  needsRestart,
  busyApp,
  cancellingApp,
  togglingChineseUi,
  uiPatchProgress,
  savingMcp: _savingMcp,
  mcpEnabledCount,
  mcpTotalCount,
  selfUpdateSummary,
  onNavigate,
  onOpenMcpDetail,
  edgeOneStatus = null,
  edgeOneSites = [],
  onOpenWebPage,
  extensionsSummary,
  onOpenExtensions,
  onSetMode,
  onLaunchApp,
  onRestartApp,
  onCloseApp,
  onInstallOrUpgrade,
  onCancelInstall,
  onToggleMainChineseUi,
  onToggleCoreMcp: _onToggleCoreMcp,
  onToggleWebPageMcp: _onToggleWebPageMcp,
  onOpenModelSquare,
  onInstallSelfUpdate,
  onOpenChangelog,
}: OverviewPanelProps) {
  const appsById = new Map((dashboard?.apps ?? []).map((app) => [app.id, app]));
  const allOrderedApps = CLIENT_ORDER.map((id) => appsById.get(id)).filter(
    (app): app is AppSnapshot => Boolean(app),
  );
  const hiddenAppsSet = new Set<AppId>(dashboard?.state.hiddenApps ?? []);
  const visibleOrderedApps = allOrderedApps.filter((app) => !hiddenAppsSet.has(app.id));
  const orderedApps = visibleOrderedApps.length > 0 ? visibleOrderedApps : allOrderedApps;
  const hiddenCount = allOrderedApps.length - orderedApps.length;

  const preferZh = dashboard?.state.preferChineseUi ?? true;
  const anyUpdatableUiPatch = orderedApps.some(
    (a) =>
      (a.id === "antigravity" || a.id === "claude") &&
      a.install.installed &&
      (a.uiPatch.status === "outdated_after_upgrade" || Boolean(a.uiPatch.updateAvailable)),
  );
  const anyMissingUiPatch = orderedApps.some(
    (a) =>
      (a.id === "antigravity" || a.id === "claude") &&
      a.install.installed &&
      (a.uiPatch.status === "unpatched" ||
        a.uiPatch.status === "outdated_after_upgrade" ||
        Boolean(a.uiPatch.updateAvailable)),
  );
  const anyMissingZhConfig = orderedApps.some(
    (a) => a.id !== "dsh-tako" && a.install.installed && !a.chineseConfigured,
  );
  const chineseFullyActive = preferZh && !anyMissingUiPatch && !anyMissingZhConfig;

  const mcp = dashboard?.state.mcp ?? null;

  return (
    <div className="tako-page-overview flex flex-col">
      {/* Compact Self-Update Banner */}
      {(selfUpdateSummary.status === "available" ||
        selfUpdateSummary.status === "downloading" ||
        selfUpdateSummary.status === "installing") && (
        <div className="rounded-[12px] border border-[var(--accent-border)] bg-[var(--accent-soft)]/80 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <ArrowUpCircle className="h-4 w-4 text-[var(--accent)] shrink-0" />
            <div className="text-[12.5px] font-medium text-[var(--text-primary)] truncate">
              {selfUpdateSummary.status === "downloading"
                ? `正在下载 Tako Switch v${selfUpdateSummary.version ?? ""}（${Math.round(selfUpdateSummary.percent ?? 0)}%）`
                : selfUpdateSummary.status === "installing"
                  ? "正在安装新版本，完成后将自动重启..."
                  : `Tako Switch v${selfUpdateSummary.version ?? ""} 可更新`}
            </div>
          </div>
          {selfUpdateSummary.status === "available" && (
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={onOpenChangelog}
                className="h-7 px-2.5 rounded-[7px] border border-[var(--accent-border)] bg-[var(--bg-card)]/90 hover:bg-[var(--bg-card)] text-[11.5px] font-medium text-[var(--text-primary)] inline-flex items-center gap-1 cursor-pointer"
              >
                <FileText className="h-3 w-3" />
                <span>更新日志</span>
              </button>
              <button
                type="button"
                onClick={onInstallSelfUpdate}
                className="h-7 px-2.5 rounded-[7px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[11.5px] font-medium cursor-pointer"
              >
                立即更新
              </button>
            </div>
          )}
        </div>
      )}

      {/* Section 1: Desktop Clients (Classic Quick-Action Rows + Secondary Page Entry) */}
      <section className="flex flex-col gap-2 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-0.5 min-w-0">
          <div className="flex items-center flex-wrap gap-1.5 min-w-0">
            <h2 className="text-[12.5px] font-semibold text-[var(--text-secondary)] shrink-0">
              桌面客户端
            </h2>

            <button
              type="button"
              data-testid="main-chinese-ui-toggle"
              disabled={!dashboard || togglingChineseUi || busyApp !== null}
              onClick={onToggleMainChineseUi}
              title={
                chineseFullyActive
                  ? "三端简体中文配置与界面汉化已生效（后续词典更新将自动同步）· 点击可一键关闭并恢复"
                  : preferZh && anyUpdatableUiPatch
                    ? "检测到新版简体中文词典（客户端关闭时会自动同步，点击也可立即更新）"
                    : "一键同步 Codex / Claude / Antigravity 简体中文配置与界面汉化"
              }
              className={`h-6 px-2.5 rounded-full border text-[11px] font-medium inline-flex items-center gap-1 transition cursor-pointer disabled:opacity-60 shrink-0 ${
                chineseFullyActive
                  ? "bg-[var(--success-soft)] border-[var(--success-border)] text-[var(--success)] hover:opacity-90"
                  : "bg-[var(--accent-soft)] border-[var(--accent-border)] text-[var(--accent)] hover:bg-[var(--accent-border)]"
              }`}
            >
              <Globe className="h-3 w-3 shrink-0" />
              <span>
                {togglingChineseUi
                  ? "汉化同步中..."
                  : chineseFullyActive
                    ? "三端汉化：已开启"
                    : preferZh && anyUpdatableUiPatch
                      ? "更新三端汉化"
                      : "一键三端汉化"}
              </span>
            </button>

            <button
              type="button"
              data-testid="open-model-square-btn"
              onClick={onOpenModelSquare}
              title="免登录浏览全量模型单价、折扣倍率与吞吐速度"
              className="h-6 px-2.5 rounded-full border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] hover:border-[var(--border-strong)] text-[11px] font-medium text-[var(--text-primary)] inline-flex items-center gap-1 transition cursor-pointer shrink-0"
            >
              <LayoutGrid className="h-3 w-3 text-[var(--accent)] shrink-0" />
              <span>模型广场</span>
            </button>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {hiddenCount > 0 ? (
              <button
                type="button"
                data-testid="overview-manage-hidden-apps"
                onClick={() => onNavigate("general")}
                title="前往通用设置管理首页显示的桌面工具"
                className="h-6 px-2.5 rounded-full border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] hover:border-[var(--border-strong)] text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1 transition cursor-pointer shrink-0"
              >
                <span>已隐藏 {hiddenCount} 个工具 · 管理</span>
              </button>
            ) : (
              <span className="hidden sm:inline text-[11.5px] text-[var(--text-muted)]">
                点右侧「设置」进入各软件独立配置
              </span>
            )}
          </div>
        </div>

        {/* Live Chinese Localization Progress Card */}
        {uiPatchProgress ? (
          <div
            data-testid="ui-patch-progress-card"
            className="rounded-[12px] border px-3.5 py-2.5 flex flex-col gap-1.5 transition-all"
            style={{
              backgroundColor:
                uiPatchProgress.stage === "done"
                  ? "var(--success-soft)"
                  : uiPatchProgress.stage === "error"
                    ? "var(--danger-soft)"
                    : "var(--accent-soft)",
              borderColor:
                uiPatchProgress.stage === "done"
                  ? "var(--success-border)"
                  : uiPatchProgress.stage === "error"
                    ? "rgba(201, 76, 76, 0.28)"
                    : "var(--accent-border)",
            }}
          >
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <div className="flex items-center gap-2 min-w-0 font-medium text-[var(--text-primary)]">
                {uiPatchProgress.stage === "done" ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-[var(--success)] shrink-0" />
                ) : (
                  <Loader2 className="h-3.5 w-3.5 text-[var(--accent)] animate-spin shrink-0" />
                )}
                <span className="truncate">{uiPatchProgress.message}</span>
              </div>
              <span
                className="tabular-nums font-semibold shrink-0"
                style={{
                  color:
                    uiPatchProgress.stage === "done"
                      ? "var(--success)"
                      : uiPatchProgress.stage === "error"
                        ? "var(--danger)"
                        : "var(--accent)",
                }}
              >
                {Math.round(uiPatchProgress.percent)}%
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-[var(--bg-card)]/75 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300 ease-out"
                style={{
                  width: `${Math.max(4, Math.min(100, uiPatchProgress.percent))}%`,
                  backgroundColor:
                    uiPatchProgress.stage === "done"
                      ? "var(--success)"
                      : uiPatchProgress.stage === "error"
                        ? "var(--danger)"
                        : "var(--accent)",
                }}
              />
            </div>
          </div>
        ) : preferZh && anyUpdatableUiPatch ? (
          <div
            data-testid="ui-patch-update-banner"
            className="rounded-[12px] border border-[var(--accent-border)] bg-[var(--accent-soft)]/75 px-3.5 py-2 flex flex-wrap items-center justify-between gap-2"
          >
            <div className="flex items-center gap-2 min-w-0 text-[12px] text-[var(--text-primary)]">
              <Globe className="h-3.5 w-3.5 text-[var(--accent)] shrink-0" />
              <span className="truncate">
                检测到新版简体中文汉化（
                {orderedApps
                  .filter(
                    (a) =>
                      (a.id === "antigravity" || a.id === "claude") &&
                      a.install.installed &&
                      (a.uiPatch.status === "outdated_after_upgrade" ||
                        Boolean(a.uiPatch.updateAvailable)),
                  )
                  .map((a) => APP_DISPLAY_NAMES[a.id] ?? a.name)
                  .join("、")}
                ），关闭应用后将自动更新
              </span>
            </div>
            <button
              type="button"
              disabled={togglingChineseUi || busyApp !== null}
              onClick={onToggleMainChineseUi}
              className="h-7 px-2.5 rounded-[7px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[11.5px] font-medium cursor-pointer disabled:opacity-60 shrink-0"
            >
              立即更新汉化
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="tako-card-surface border border-[var(--border)] bg-[var(--bg-card)] p-6 text-center text-[13px] text-[var(--text-secondary)]">
            正在读取本机客户端与配置...
          </div>
        ) : (
          <div className="flex flex-col tako-list-stack">
            {orderedApps.map((app) => {
              const update = updatesMap[app.id];
              const progress = installProgress[app.id];
              const isBusy = busyApp === app.id;
              const restartRequired = Boolean(needsRestart[app.id]);
              const hasIssue = app.diagnostic.issues.length > 0;
              const pendingAutoTako =
                Boolean(dashboard?.account.loggedIn) &&
                app.mode === "official" &&
                !(dashboard?.state.explicitOfficialApps ?? []).includes(app.id);
              const displayMode: AppMode = pendingAutoTako ? "tako" : app.mode;

              return (
                <div
                  key={app.id}
                  className={`tako-card-surface border bg-[var(--bg-card)] shadow-[var(--shadow-card)] transition-colors overflow-hidden ${
                    app.running
                      ? "border-[var(--success-border)]"
                      : "border-[var(--border)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  <div className="tako-client-row flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-2">
                    {/* Brand & Summary (click enters client subpage) */}
                    <button
                      type="button"
                      onClick={() => onNavigate(app.id)}
                      className="w-full sm:w-auto sm:flex-1 min-w-0 flex items-center gap-3 text-left group cursor-pointer"
                    >
                      <AppBrandIcon appId={app.id} className="tako-brand-size" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[13.5px] font-semibold tracking-[-0.01em] text-[var(--text-primary)] group-hover:text-[var(--accent)] transition truncate">
                            {APP_DISPLAY_NAMES[app.id]}
                          </span>
                          {app.install.installed && app.install.version && (
                            <span className="text-[11px] text-[var(--text-muted)] tabular-nums shrink-0">
                              {formatVersion(app.install.version)}
                            </span>
                          )}
                          {app.running && (
                            <span
                              className="inline-flex items-center gap-1 text-[11px] text-[var(--success)] shrink-0"
                              title="正在运行"
                            >
                              <span className="tako-live-dot" />
                              <span>运行中</span>
                            </span>
                          )}
                          {update?.hasUpdate && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] shrink-0">
                              有更新
                            </span>
                          )}
                          {preferZh && app.uiPatch.updateAvailable && !update?.hasUpdate && (
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] shrink-0"
                              title="检测到新版汉化词典，关闭客户端后将自动同步，或点顶部「更新三端汉化」立即应用"
                            >
                              汉化可更新
                            </span>
                          )}
                          {hasIssue && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[var(--warning-soft)] text-[var(--warning)] shrink-0">
                              需检查
                            </span>
                          )}
                        </div>
                        <div className="text-[11.5px] text-[var(--text-muted)] truncate mt-0.5">
                          {briefClientSummary(app, update, pendingAutoTako)}
                        </div>
                      </div>
                    </button>

                    {/* Fixed-Width Mode Switcher */}
                    <div className="w-[116px] shrink-0 grid grid-cols-2 p-0.5 rounded-[9px] bg-[var(--bg-pill)] border border-[var(--border)]">
                      {MODE_OPTIONS.map((option) => {
                        const active = displayMode === option.id;
                        const label =
                          app.id === "dsh-tako"
                            ? option.id === "tako"
                              ? "同步"
                              : "独立"
                            : option.label;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            disabled={isBusy}
                            onClick={() => onSetMode(app, option.id)}
                            className={`h-[var(--density-ctrl-sm-h)] rounded-[7px] text-[12px] transition cursor-pointer disabled:opacity-60 ${
                              active
                                ? "bg-[var(--bg-card)] font-semibold shadow-[var(--shadow-segment)]"
                                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            }`}
                            style={
                              active
                                ? {
                                    color:
                                      option.id === "tako"
                                        ? "var(--accent)"
                                        : "var(--text-primary)",
                                  }
                                : undefined
                            }
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>

                    {/* Standalone Per-App Update Button (never batch-updates other tools) */}
                    {app.install.installed && update?.hasUpdate && !progress && (
                      <button
                        type="button"
                        data-testid={`overview-upgrade-${app.id}`}
                        disabled={busyApp !== null}
                        onClick={() => onInstallOrUpgrade(app.id)}
                        title={`单独更新 ${APP_DISPLAY_NAMES[app.id]}${
                          update.remoteVersion ? ` 至 ${formatVersion(update.remoteVersion)}` : ""
                        }`}
                        className="tako-ctrl-h px-2.5 rounded-[9px] bg-[var(--accent-soft)] hover:bg-[var(--accent-border)] text-[var(--accent)] border border-[var(--accent-border)] text-[12px] font-medium inline-flex items-center gap-1 transition cursor-pointer disabled:opacity-60 shrink-0"
                      >
                        <ArrowUpCircle className="h-3.5 w-3.5 shrink-0" />
                        <span>更新</span>
                      </button>
                    )}

                    {/* Fixed-Width Primary Action Slot */}
                    <div className="w-[96px] shrink-0 flex items-center justify-end">
                      {progress ? (
                        progress.stage === "downloading" ? (
                          <div className="w-full h-8 px-2 rounded-[9px] bg-[var(--accent-soft)] border border-[var(--accent-border)] flex items-center justify-between gap-1 text-[11px] font-medium text-[var(--accent)] tabular-nums">
                            <span className="truncate">{Math.round(progress.percent)}%</span>
                            <button
                              type="button"
                              disabled={cancellingApp === app.id}
                              onClick={() => onCancelInstall(app.id)}
                              className="px-1 py-0.5 rounded bg-[var(--bg-card)]/80 hover:bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--danger)] text-[10.5px] shrink-0 cursor-pointer disabled:opacity-50"
                            >
                              {cancellingApp === app.id ? "..." : "取消"}
                            </button>
                          </div>
                        ) : (
                          <div className="w-full h-8 px-2 rounded-[9px] bg-[var(--accent-soft)] border border-[var(--accent-border)] flex items-center justify-center text-[11px] font-medium text-[var(--accent)] tabular-nums truncate">
                            {installStageLabel(progress.stage)} {Math.round(progress.percent)}%
                          </div>
                        )
                      ) : !app.install.installed ? (
                        update && !update.platformSupported ? (
                          <span className="w-full tako-ctrl-h rounded-[9px] bg-[var(--bg-subtle)] text-[var(--text-muted)] text-[12px] font-medium flex items-center justify-center">
                            暂不支持
                          </span>
                        ) : (
                          <button
                            type="button"
                            data-testid={`overview-action-${app.id}`}
                            disabled={isBusy}
                            onClick={() => onInstallOrUpgrade(app.id)}
                            className="w-full tako-ctrl-h rounded-[9px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium flex items-center justify-center gap-1.5 transition cursor-pointer disabled:opacity-60"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>{isBusy ? "安装中" : "安装"}</span>
                          </button>
                        )
                      ) : restartRequired ? (
                        <button
                          type="button"
                          data-testid={`overview-action-${app.id}`}
                          disabled={isBusy}
                          onClick={() => onRestartApp(app.id)}
                          title="重启应用使最新配置生效"
                          className="w-full tako-ctrl-h rounded-[9px] text-[12px] font-medium flex items-center justify-center gap-1.5 transition cursor-pointer disabled:opacity-60"
                          style={{
                            backgroundColor: "var(--warning-soft)",
                            color: "var(--warning)",
                          }}
                        >
                          <RotateCw className={`h-3.5 w-3.5 ${isBusy ? "animate-spin" : ""}`} />
                          <span>重启生效</span>
                        </button>
                      ) : app.running ? (
                        <button
                          type="button"
                          data-testid={`overview-action-${app.id}`}
                          disabled={isBusy}
                          onClick={() => onCloseApp(app.id)}
                          title={`关闭 ${APP_DISPLAY_NAMES[app.id]}`}
                          className="w-full tako-ctrl-h rounded-[9px] border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] text-[var(--text-primary)] text-[12px] font-medium flex items-center justify-center gap-1.5 transition cursor-pointer disabled:opacity-60"
                        >
                          <Power className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                          <span>{isBusy ? "关闭中" : "关闭"}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-testid={`overview-action-${app.id}`}
                          disabled={isBusy}
                          onClick={() => onLaunchApp(app.id)}
                          title={`一键打开 ${APP_DISPLAY_NAMES[app.id]}`}
                          className="w-full tako-ctrl-h rounded-[9px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium flex items-center justify-center gap-1.5 transition cursor-pointer disabled:opacity-60"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          <span>{isBusy ? "打开中" : "打开"}</span>
                        </button>
                      )}
                    </div>

                    {/* Secondary Page Entry: Per-Client Settings */}
                    <button
                      type="button"
                      data-testid={`open-client-settings-${app.id}`}
                      onClick={() => onNavigate(app.id)}
                      title={`进入 ${APP_DISPLAY_NAMES[app.id]} 独立设置（模型、汉化、升级与诊断）`}
                      className="tako-ctrl-h px-2.5 rounded-[9px] border border-[var(--border)] bg-[var(--bg-subtle)]/55 hover:bg-[var(--bg-subtle)] hover:border-[var(--border-strong)] text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1 transition cursor-pointer shrink-0"
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                      <span>设置</span>
                    </button>
                  </div>

                  {/* Inline Download Progress Strip */}
                  {progress && (
                    <div className="px-3.5 pb-2.5 flex flex-col gap-1">
                      <div className="h-1 w-full rounded-full bg-[var(--bg-subtle)] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-200"
                          style={{
                            width: `${Math.max(4, Math.min(100, progress.percent))}%`,
                            backgroundColor:
                              progress.stage === "error"
                                ? "var(--danger)"
                                : "var(--accent)",
                          }}
                        />
                      </div>
                      <span className="tabular-nums text-[11px] text-[var(--text-secondary)] truncate">
                        {progress.message}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Section 2: Three Equal-Tier Capability Entry Cards (Desktop Clients above untouched) */}
      {(() => {
        const safeSites = Array.isArray(edgeOneSites) ? edgeOneSites : [];
        const siteCount = safeSites.length;
        const previewCount = safeSites.filter((s) => s.environment === "preview").length;
        const wpAuthed = Boolean(edgeOneStatus?.authenticated);
        const wpStatusText = wpAuthed
          ? "EdgeOne · 已就绪"
          : edgeOneStatus?.error
            ? "EdgeOne · 需处理"
            : "EdgeOne · 待登录";
        const extMcpCount = extensionsSummary?.mcpCount ?? 0;
        const extSkillsCount = extensionsSummary?.skillsCount ?? 0;
        const extSkillsUpdatable = extensionsSummary?.skillsUpdatableCount ?? 0;
        const extPluginsCount = extensionsSummary?.pluginsCount ?? 0;
        const extPromptsCount = extensionsSummary?.promptsCount ?? 0;
        const extTotalCount =
          extMcpCount + extSkillsCount + extPluginsCount + extPromptsCount;

        return (
          <section className="grid grid-cols-1 min-[640px]:grid-cols-3 gap-[var(--density-section-gap)] min-w-0">
            {/* Card 1: Tako Super MCP */}
            <article className="tako-card-surface border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--border-strong)] shadow-[var(--shadow-card)] px-[var(--density-card-px)] py-[var(--density-card-py)] flex flex-col gap-2.5 min-w-0 transition-colors">
              <div className="flex items-center gap-2 min-w-0">
                <span className="h-7 w-7 rounded-[8px] bg-[var(--accent-soft)] text-[var(--accent)] inline-flex items-center justify-center shrink-0">
                  <Sparkles className="h-3.5 w-3.5" strokeWidth={1.9} />
                </span>
                <h2 className="text-[13.5px] font-semibold text-[var(--text-primary)] truncate">
                  Tako 超级 MCP
                </h2>
              </div>

              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-[var(--text-primary)] tabular-nums">
                  核心能力 {mcpEnabledCount} / {mcpTotalCount} 已开启
                </div>
                <p className="text-[11.5px] text-[var(--text-secondary)] truncate mt-0.5">
                  图像 · 视频 · 声音 · 搜索 · 多模型会诊
                </p>
              </div>

              <div className="mt-auto pt-1">
                <button
                  type="button"
                  data-testid="open-mcp-center"
                  onClick={() => onOpenMcpDetail()}
                  className="w-full h-[29px] px-2.5 rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] hover:border-[var(--border-strong)] text-[12px] font-medium text-[var(--text-primary)] inline-flex items-center justify-center gap-1 transition cursor-pointer"
                >
                  <span>配置与演示 →</span>
                </button>
              </div>
            </article>

            {/* Card 2: Website Hosting · Tako Web Page */}
            <article
              data-testid="overview-webpage-card"
              className="tako-card-surface border border-[var(--accent-border)] hover:border-[var(--accent)]/60 shadow-[var(--shadow-card)] px-[var(--density-card-px)] py-[var(--density-card-py)] flex flex-col gap-2.5 min-w-0 transition-colors"
              style={{ background: "var(--webpage-grad)" }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="h-7 w-7 rounded-[8px] bg-[var(--success-soft)] text-[var(--success)] inline-flex items-center justify-center shrink-0">
                  <Globe2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                </span>
                <h2 className="text-[13.5px] font-semibold text-[var(--text-primary)] truncate">
                  网站托管 · Web Page
                </h2>
              </div>

              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-[var(--text-primary)] truncate">
                  {wpStatusText}
                </div>
                <p className="text-[11.5px] text-[var(--text-secondary)] truncate mt-0.5 tabular-nums">
                  {siteCount > 0
                    ? `${siteCount} 个站点${previewCount > 0 ? ` · ${previewCount} 个预览` : ""}`
                    : "拖入目录或对话一句话上线"}
                  {" · AI MCP "}
                  {mcp?.webPage ? "已启用" : "已关闭"}
                </p>
              </div>

              <div className="mt-auto pt-1 flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="overview-webpage-deploy"
                  onClick={() => onOpenWebPage(true)}
                  className="h-[29px] px-2.5 rounded-[8px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium inline-flex items-center justify-center gap-1 transition cursor-pointer shrink-0"
                >
                  <Rocket className="h-3 w-3 shrink-0" />
                  <span>快捷部署</span>
                </button>
                <button
                  type="button"
                  data-testid="open-webpage"
                  onClick={() => onOpenWebPage(false)}
                  className="flex-1 h-[29px] px-2.5 rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] hover:border-[var(--border-strong)] text-[12px] font-medium text-[var(--text-primary)] inline-flex items-center justify-center transition cursor-pointer min-w-0"
                >
                  <span>管理 →</span>
                </button>
              </div>
            </article>

            {/* Card 3: Universal Extensions Hub (preserves all existing E2E testids) */}
            <article
              data-testid="ext-hub-home-section"
              className="tako-card-surface border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--border-strong)] shadow-[var(--shadow-card)] px-[var(--density-card-px)] py-[var(--density-card-py)] flex flex-col gap-2.5 min-w-0 transition-colors"
            >
              <div className="flex items-center justify-between gap-2 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="h-7 w-7 rounded-[8px] bg-[var(--coral-soft)] text-[var(--coral)] inline-flex items-center justify-center shrink-0">
                    <LayoutGrid className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </span>
                  <h2 className="text-[13.5px] font-semibold text-[var(--text-primary)] truncate">
                    通用扩展中心
                  </h2>
                </div>
                {extSkillsUpdatable > 0 && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[var(--success-soft)] text-[var(--success)] shrink-0 tabular-nums">
                    {extSkillsUpdatable} 可更新
                  </span>
                )}
              </div>

              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-[var(--text-primary)] tabular-nums">
                  共 {extTotalCount} 项扩展
                </div>
                <div className="grid grid-cols-2 min-[760px]:flex min-[760px]:items-center min-[760px]:justify-between gap-x-1.5 gap-y-1 mt-1 text-[11px] text-[var(--text-secondary)] tabular-nums">
                  {(
                    [
                      { id: "mcp", label: "MCP", count: extMcpCount, updatable: 0 },
                      {
                        id: "skills",
                        label: "Skills",
                        count: extSkillsCount,
                        updatable: extSkillsUpdatable,
                      },
                      { id: "plugins", label: "插件", count: extPluginsCount, updatable: 0 },
                      { id: "prompts", label: "预设", count: extPromptsCount, updatable: 0 },
                    ] as const
                  ).map((item) => {
                    const detailText =
                      item.updatable > 0
                        ? `${item.count} 项 · ${item.updatable} 可更新`
                        : `${item.count} 项`;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-testid={`open-ext-hub-${item.id}`}
                        onClick={() => onOpenExtensions(item.id)}
                        title={`${item.label}：${detailText}`}
                        className="relative inline-flex items-center gap-1 text-left min-[760px]:justify-center whitespace-nowrap rounded-[5px] px-1 py-0.5 -mx-1 hover:bg-[var(--bg-subtle)] hover:text-[var(--accent)] transition cursor-pointer"
                      >
                        <span aria-hidden="true">
                          {item.label} {item.count}
                        </span>
                        {item.updatable > 0 && (
                          <span
                            aria-hidden="true"
                            className="h-1.5 w-1.5 rounded-full bg-[var(--success)] shrink-0"
                          />
                        )}
                        <span className="sr-only">
                          {item.label} {detailText}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-auto pt-1">
                <button
                  type="button"
                  data-testid="open-ext-hub"
                  onClick={() => onOpenExtensions()}
                  className="w-full h-[29px] px-2.5 rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] hover:border-[var(--border-strong)] text-[12px] font-medium text-[var(--text-primary)] inline-flex items-center justify-center gap-1 transition cursor-pointer"
                >
                  <span>打开扩展中心 →</span>
                </button>
              </div>
            </article>
          </section>
        );
      })()}
    </div>
  );
}
