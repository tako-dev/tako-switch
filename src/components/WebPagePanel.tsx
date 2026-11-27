import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Activity,
  AlertCircle,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  Globe2,
  HelpCircle,
  History,
  KeyRound,
  Layers,
  Loader2,
  LogOut,
  Pin,
  PinOff,
  Plus,
  QrCode,
  RefreshCw,
  Rocket,
  Search,
  Settings2,
  Sparkles,
  StickyNote,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  api,
  type EdgeOneDeployProgressEvent,
  type EdgeOneDeployResult,
  type EdgeOneEnvVar,
  type EdgeOneProgressEvent,
  type EdgeOneSiteHealth,
  type EdgeOneSiteRecord,
  type EdgeOneSourceInspection,
  type EdgeOneStatus,
  type McpToolsConfig,
} from "../lib/api";
import { encodeQrMatrix, qrMatrixToSvgPath } from "../lib/qrcode";
import { SegmentedControl, StatusPill, ToggleSwitch } from "./UiPrimitives";
import {
  EXT_BUTTON,
  EXT_INPUT,
  EXT_PRIMARY_BUTTON,
  ExtMoreDropdown,
  ExtSlideDrawer,
} from "./extensions/ExtensionPrimitives";

interface WebPagePanelProps {
  mcp: McpToolsConfig | null;
  savingMcp: boolean;
  edgeOneStatus: EdgeOneStatus | null;
  sites: EdgeOneSiteRecord[];
  autoFocusDeploy?: boolean;
  onConsumeAutoFocusDeploy?: () => void;
  onStatusChange: (status: EdgeOneStatus) => void;
  onSitesChange: (sites: EdgeOneSiteRecord[]) => void;
  onRefreshStatus: (force?: boolean) => Promise<EdgeOneStatus | null>;
  onRefreshSites: () => Promise<EdgeOneSiteRecord[]>;
  onToggleWebPage: (next: boolean) => Promise<void>;
  onSaveEdgeOneConfig: (token: string, projectName: string) => Promise<void>;
  onNotify?: (message: string) => void;
}

const DEFAULT_CN_CONSOLE = "https://console.cloud.tencent.com/edgeone/pages";
const DEFAULT_INTL_CONSOLE = "https://console.tencentcloud.com/edgeone/pages";
const AI_PROMPT_SNIPPET = "帮我把这个网站通过 Tako Web Page 部署上线";

function formatRelativeTime(epochMs: number): string {
  if (!epochMs) return "刚刚";
  const diff = Math.max(0, Date.now() - epochMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function compactPath(raw?: string | null): string {
  if (!raw) return "";
  return raw.replace(/^\/Users\/[^/]+/, "~").replace(/^C:\\Users\\[^\\]+/i, "~");
}

function LocalQrSvg({ url, size = 152 }: { url: string; size?: number }) {
  const { viewBox, path } = useMemo(() => {
    const matrix = encodeQrMatrix(url);
    return qrMatrixToSvgPath(matrix, 2);
  }, [url]);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${viewBox} ${viewBox}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`访问二维码 ${url}`}
      className="block rounded-md bg-white"
    >
      <rect width={viewBox} height={viewBox} fill="#ffffff" />
      <path d={path} fill="#111827" />
    </svg>
  );
}

export function WebPagePanel({
  mcp,
  savingMcp,
  edgeOneStatus,
  sites,
  autoFocusDeploy = false,
  onConsumeAutoFocusDeploy,
  onStatusChange,
  onSitesChange,
  onRefreshStatus,
  onRefreshSites,
  onToggleWebPage,
  onSaveEdgeOneConfig,
  onNotify,
}: WebPagePanelProps) {
  // Account / Auth state
  const [loginSite, setLoginSite] = useState<"china" | "global">("china");
  const [refreshingAccount, setRefreshingAccount] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [installingRuntime, setInstallingRuntime] = useState(false);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [authProgress, setAuthProgress] = useState<EdgeOneProgressEvent | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  // Quick Deploy state
  const [dragHover, setDragHover] = useState(false);
  const [showPathInput, setShowPathInput] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<EdgeOneSourceInspection | null>(null);
  const [deployProjectName, setDeployProjectName] = useState("");
  const [deployEnv, setDeployEnv] = useState<"production" | "preview">("production");
  const [deployArea, setDeployArea] = useState<"global" | "overseas">("global");
  const [deployAdvancedOpen, setDeployAdvancedOpen] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [redeployingSiteId, setRedeployingSiteId] = useState<string | null>(null);
  const [deployProgress, setDeployProgress] = useState<EdgeOneDeployProgressEvent | null>(null);
  const [deployLogs, setDeployLogs] = useState<string[]>([]);
  const [showDeployLogs, setShowDeployLogs] = useState(false);
  const [lastDeployResult, setLastDeployResult] = useState<EdgeOneDeployResult | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const deploySectionRef = useRef<HTMLDivElement | null>(null);

  // Site List filters & interactive panels
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearch = useDeferredValue(searchQuery.trim().toLowerCase());
  const [envFilter, setEnvFilter] = useState<"all" | "production" | "preview">("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "ui" | "mcp">("all");
  const [sortBy, setSortBy] = useState<"recent" | "name" | "count">("recent");
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [qrModalSite, setQrModalSite] = useState<{ title: string; url: string } | null>(null);
  const [healthMap, setHealthMap] = useState<Record<string, EdgeOneSiteHealth>>({});
  const [checkingHealthIds, setCheckingHealthIds] = useState<Record<string, boolean>>({});
  const [batchCheckingHealth, setBatchCheckingHealth] = useState(false);

  // Drawers & Modals
  const [advancedConfigOpen, setAdvancedConfigOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState(mcp?.edgeoneApiToken ?? "");
  const [defaultProjectDraft, setDefaultProjectDraft] = useState(mcp?.edgeoneProjectName ?? "");
  const [helpOpen, setHelpOpen] = useState(false);
  const [noteTarget, setNoteTarget] = useState<EdgeOneSiteRecord | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<EdgeOneSiteRecord | null>(null);

  // Env Vars Drawer state
  const [envSite, setEnvSite] = useState<EdgeOneSiteRecord | null>(null);
  const [envTab, setEnvTab] = useState<"production" | "preview">("production");
  const [envVars, setEnvVars] = useState<EdgeOneEnvVar[]>([]);
  const [envLoading, setEnvLoading] = useState(false);
  const [envBusy, setEnvBusy] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  const [envNewKey, setEnvNewKey] = useState("");
  const [envNewVal, setEnvNewVal] = useState("");

  useEffect(() => {
    setTokenDraft(mcp?.edgeoneApiToken ?? "");
    setDefaultProjectDraft(mcp?.edgeoneProjectName ?? "");
  }, [mcp?.edgeoneApiToken, mcp?.edgeoneProjectName]);

  // Smooth auto-focus deploy box when user enters from Overview "快捷部署"
  useEffect(() => {
    if (!autoFocusDeploy) return;
    deploySectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    onConsumeAutoFocusDeploy?.();
  }, [autoFocusDeploy, onConsumeAutoFocusDeploy]);

  // Fast initial hydration: read local sites (<1ms) & refresh status silently only if needed
  useEffect(() => {
    void onRefreshSites();
    if (!edgeOneStatus || (edgeOneStatus.hasLocalCredentials && !edgeOneStatus.authenticated && !edgeOneStatus.error)) {
      void onRefreshStatus(false);
    }
  }, [onRefreshSites, onRefreshStatus]);

  // Listen to backend streaming events (login progress, deploy progress, sites updated)
  useEffect(() => {
    let active = true;
    const unsubs: Array<() => void> = [];
    void listen<EdgeOneProgressEvent>("edgeone-progress", (e) => {
      if (active) setAuthProgress(e.payload);
    }).then((u) => unsubs.push(u));
    void listen<EdgeOneDeployProgressEvent>("edgeone-deploy-progress", (e) => {
      if (!active) return;
      setDeployProgress(e.payload);
      if (e.payload.logLine) {
        setDeployLogs((prev) => [...prev.slice(-80), e.payload.logLine!]);
      }
    }).then((u) => unsubs.push(u));
    void listen("edgeone-sites-changed", () => {
      if (active) void onRefreshSites();
    }).then((u) => unsubs.push(u));

    // Also refresh local ledger on window focus so AI MCP deployments appear immediately
    const onFocus = () => {
      if (active) void onRefreshSites();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      unsubs.forEach((fn) => fn());
    };
  }, [onRefreshSites]);

  // Native Tauri drag-and-drop for instant Quick Deploy
  const handleInspectPath = useCallback(async (rawPath: string) => {
    const trimmed = rawPath.trim();
    if (!trimmed) return;
    setInspecting(true);
    setDeployError(null);
    setLastDeployResult(null);
    try {
      const info = await api.inspectEdgeOneSource(trimmed);
      setInspection(info);
      setPathDraft(info.path);
      setDeployProjectName(info.linkedProjectName || info.suggestedProjectName || "");
      if (!info.valid && info.warning) {
        setDeployError(info.warning);
      }
    } catch (err) {
      setDeployError(String(err));
    } finally {
      setInspecting(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (disposed) return;
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragHover(true);
          } else if (event.payload.type === "leave") {
            setDragHover(false);
          } else if (event.payload.type === "drop") {
            setDragHover(false);
            const dropped = event.payload.paths?.[0];
            if (dropped && !deploying) {
              void handleInspectPath(dropped);
            }
          }
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // Non-Tauri browser preview environment
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [deploying, handleInspectPath]);

  const copyText = useCallback(
    async (key: string, text: string, label?: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopiedKey(key);
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => setCopiedKey(null), 1600);
        if (label) onNotify?.(label);
      } catch {
        onNotify?.("复制失败，请手动选中复制");
      }
    },
    [onNotify],
  );

  // Account Handlers
  const handleManualRefresh = async () => {
    setRefreshingAccount(true);
    setActionError(null);
    try {
      await Promise.all([onRefreshStatus(true), onRefreshSites()]);
      onNotify?.("EdgeOne 状态与站点记录已刷新");
    } catch (err) {
      setActionError(String(err));
    } finally {
      setRefreshingAccount(false);
    }
  };

  const handleLogin = async () => {
    setLoggingIn(true);
    setActionError(null);
    setAuthProgress({
      stage: "prepare",
      percent: 8,
      message: "正在检查运行环境并准备腾讯云授权...",
    });
    try {
      const next = await api.loginEdgeOne(loginSite);
      onStatusChange(next);
      onNotify?.("腾讯云 EdgeOne 登录成功，AI 网站发布已就绪");
    } catch (err) {
      const msg = String(err);
      if (!msg.includes("已取消")) {
        setActionError(msg);
      }
    } finally {
      setLoggingIn(false);
      setAuthProgress(null);
    }
  };

  const handleCancelLogin = async () => {
    try {
      await api.cancelEdgeOneLogin();
    } catch {
      // ignore
    }
  };

  const handleUpgradeRuntime = async () => {
    setInstallingRuntime(true);
    setActionError(null);
    setAuthProgress({
      stage: "cli",
      percent: 18,
      message: "正在更新内置 EdgeOne 部署组件...",
    });
    try {
      const next = await api.installEdgeOneRuntime(true);
      onStatusChange(next);
      onNotify?.(`EdgeOne 组件已更新至 v${next.cliVersion ?? "latest"}`);
    } catch (err) {
      setActionError(String(err));
    } finally {
      setInstallingRuntime(false);
      setAuthProgress(null);
    }
  };

  const handleSwitchWorkspace = async (workspaceId: string) => {
    if (!workspaceId || workspaceId === edgeOneStatus?.workspaceId) return;
    setSwitchingWorkspace(true);
    setActionError(null);
    try {
      const next = await api.switchEdgeOneWorkspace(workspaceId);
      onStatusChange(next);
      onNotify?.(`已切换工作空间：${next.workspaceName ?? workspaceId}`);
    } catch (err) {
      setActionError(String(err));
    } finally {
      setSwitchingWorkspace(false);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    setActionError(null);
    try {
      const next = await api.logoutEdgeOne();
      onStatusChange(next);
      onNotify?.("已退出腾讯云 EdgeOne 登录（本地站点记录已保留）");
    } catch (err) {
      setActionError(String(err));
    } finally {
      setLoggingOut(false);
    }
  };

  const handleSaveAdvanced = async () => {
    await onSaveEdgeOneConfig(tokenDraft.trim(), defaultProjectDraft.trim());
    setAdvancedConfigOpen(false);
    void onRefreshStatus(true);
  };

  // Deploy Handlers
  const handlePickSource = async (kind: "folder" | "file") => {
    setDeployError(null);
    try {
      const picked = await api.pickEdgeOneSource(kind);
      if (picked) {
        await handleInspectPath(picked);
      }
    } catch (err) {
      setDeployError(String(err));
    }
  };

  const handleCreateSampleSite = async () => {
    setInspecting(true);
    setDeployError(null);
    setLastDeployResult(null);
    try {
      const info = await api.createEdgeOneSampleSite();
      setInspection(info);
      setPathDraft(info.path);
      setDeployProjectName(info.suggestedProjectName);
      onNotify?.("已生成演示页面，点击「立即发布上线」即可体验");
    } catch (err) {
      setDeployError(String(err));
    } finally {
      setInspecting(false);
    }
  };

  const runDeploy = async (opts: {
    path: string;
    projectName?: string;
    environment: "production" | "preview";
    area: "global" | "overseas";
    redeploySiteId?: string;
  }) => {
    if (!edgeOneStatus?.authenticated) {
      setDeployError("请先登录腾讯云 EdgeOne 后再部署站点");
      return;
    }
    setDeploying(true);
    setRedeployingSiteId(opts.redeploySiteId ?? null);
    setDeployError(null);
    setLastDeployResult(null);
    setDeployLogs([]);
    setDeployProgress({
      stage: "preparing",
      percent: 6,
      message: "正在初始化部署任务...",
      projectName: opts.projectName || null,
      elapsedMs: 0,
    });
    try {
      const result = await api.deployEdgeOneWebsite({
        path: opts.path,
        projectName: opts.projectName?.trim() || null,
        environment: opts.environment,
        area: opts.area,
        source: "ui",
      });
      setLastDeployResult(result);
      await onRefreshSites();
      onNotify?.(`站点 ${result.projectName} 已上线！`);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("已取消")) {
        onNotify?.("已取消本次部署");
      } else {
        setDeployError(msg);
      }
    } finally {
      setDeploying(false);
      setRedeployingSiteId(null);
      setDeployProgress(null);
    }
  };

  const handleCancelDeploy = async () => {
    try {
      await api.cancelEdgeOneDeploy();
    } catch {
      // ignore
    }
  };

  // Site Interactive Actions
  const handleTogglePin = async (site: EdgeOneSiteRecord) => {
    try {
      const next = await api.updateEdgeOneSiteMeta({
        id: site.id,
        pinned: !site.pinned,
      });
      onSitesChange(next);
      onNotify?.(!site.pinned ? `已置顶 ${site.projectName}` : `已取消置顶 ${site.projectName}`);
    } catch (err) {
      setActionError(String(err));
    }
  };

  const handleSaveNote = async () => {
    if (!noteTarget) return;
    setSavingNote(true);
    try {
      const next = await api.updateEdgeOneSiteMeta({
        id: noteTarget.id,
        note: noteDraft,
      });
      onSitesChange(next);
      setNoteTarget(null);
      onNotify?.("站点备注已保存");
    } catch (err) {
      setActionError(String(err));
    } finally {
      setSavingNote(false);
    }
  };

  const handleRebindFolder = async (site: EdgeOneSiteRecord) => {
    try {
      const picked = await api.pickEdgeOneSource("folder");
      if (!picked) return;
      const next = await api.updateEdgeOneSiteMeta({
        id: site.id,
        localSourcePath: picked,
      });
      onSitesChange(next);
      onNotify?.(`已重新关联 ${site.projectName} 的本地目录`);
    } catch (err) {
      setActionError(String(err));
    }
  };

  const handleConfirmRemoveSite = async () => {
    if (!removeTarget) return;
    try {
      const next = await api.removeEdgeOneSiteRecord(removeTarget.id);
      onSitesChange(next);
      onNotify?.(`已移除 ${removeTarget.projectName} 的本地记录`);
      setRemoveTarget(null);
    } catch (err) {
      setActionError(String(err));
    }
  };

  const handleCheckSingleHealth = async (site: EdgeOneSiteRecord) => {
    setCheckingHealthIds((prev) => ({ ...prev, [site.id]: true }));
    try {
      const res = await api.checkEdgeOneSitesHealth([site.url]);
      if (res[0]) {
        setHealthMap((prev) => ({ ...prev, [site.url]: res[0] }));
      }
    } finally {
      setCheckingHealthIds((prev) => ({ ...prev, [site.id]: false }));
    }
  };

  const handleBatchCheckHealth = async () => {
    const urls = Array.from(new Set(filteredSites.map((s) => s.url)));
    if (urls.length === 0) return;
    setBatchCheckingHealth(true);
    try {
      const results = await api.checkEdgeOneSitesHealth(urls);
      setHealthMap((prev) => {
        const next = { ...prev };
        for (const r of results) next[r.url] = r;
        return next;
      });
      const okCount = results.filter((r) => r.reachable).length;
      onNotify?.(`已完成 ${results.length} 个站点探测：${okCount} 个可正常访问`);
    } finally {
      setBatchCheckingHealth(false);
    }
  };

  // Env Vars Drawer Actions
  const loadEnvVars = useCallback(
    async (site: EdgeOneSiteRecord, envName: "production" | "preview") => {
      if (!site.localSourcePath) return;
      setEnvLoading(true);
      setEnvError(null);
      try {
        const list = await api.edgeoneEnvList(site.localSourcePath, site.projectName, envName);
        setEnvVars(list);
      } catch (err) {
        setEnvError(String(err));
        setEnvVars([]);
      } finally {
        setEnvLoading(false);
      }
    },
    [],
  );

  const openEnvDrawer = (site: EdgeOneSiteRecord) => {
    const initialEnv = site.environment === "preview" ? "preview" : "production";
    setEnvSite(site);
    setEnvTab(initialEnv);
    setEnvNewKey("");
    setEnvNewVal("");
    setEnvError(null);
    void loadEnvVars(site, initialEnv);
  };

  const handleAddEnvVar = async () => {
    if (!envSite?.localSourcePath || !envNewKey.trim()) return;
    setEnvBusy(true);
    setEnvError(null);
    try {
      const next = await api.edgeoneEnvSet(
        envSite.localSourcePath,
        envSite.projectName,
        envNewKey.trim(),
        envNewVal,
        envTab,
      );
      setEnvVars(next);
      setEnvNewKey("");
      setEnvNewVal("");
      onNotify?.(`已写入环境变量 ${envNewKey.trim()}`);
    } catch (err) {
      setEnvError(String(err));
    } finally {
      setEnvBusy(false);
    }
  };

  const handleRemoveEnvVar = async (key: string) => {
    if (!envSite?.localSourcePath) return;
    setEnvBusy(true);
    setEnvError(null);
    try {
      const next = await api.edgeoneEnvRemove(
        envSite.localSourcePath,
        envSite.projectName,
        key,
        envTab,
      );
      setEnvVars(next);
      onNotify?.(`已移除环境变量 ${key}`);
    } catch (err) {
      setEnvError(String(err));
    } finally {
      setEnvBusy(false);
    }
  };

  const handlePullEnvVars = async () => {
    if (!envSite?.localSourcePath) return;
    setEnvBusy(true);
    setEnvError(null);
    try {
      const filePath = await api.edgeoneEnvPull(
        envSite.localSourcePath,
        envSite.projectName,
        envTab,
      );
      onNotify?.(`已拉取至 ${compactPath(filePath)}`);
    } catch (err) {
      setEnvError(String(err));
    } finally {
      setEnvBusy(false);
    }
  };

  // Computed values
  const authed = Boolean(edgeOneStatus?.authenticated);
  const authBusy = loggingIn || installingRuntime;
  const webPageEnabled = Boolean(mcp?.webPage);
  const availableWorkspaces = (edgeOneStatus?.workspaces ?? []).filter((w) => w.available);
  const displayAuthError = actionError || (!authed ? edgeOneStatus?.error ?? null : null);
  const currentWsId = edgeOneStatus?.workspaceId ?? null;

  const filteredSites = useMemo(() => {
    let list = sites.filter((s) => {
      if (envFilter !== "all" && s.environment !== envFilter) return false;
      if (sourceFilter !== "all" && s.source !== sourceFilter) return false;
      if (deferredSearch) {
        const hay = `${s.projectName} ${s.url} ${s.note ?? ""} ${s.localSourcePath ?? ""} ${s.workspaceName ?? ""}`.toLowerCase();
        if (!hay.includes(deferredSearch)) return false;
      }
      return true;
    });
    if (sortBy === "name") {
      list = [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.projectName.localeCompare(b.projectName));
    } else if (sortBy === "count") {
      list = [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.deployCount - a.deployCount);
    }
    return list;
  }, [sites, envFilter, sourceFilter, deferredSearch, sortBy]);

  const prodCount = useMemo(() => sites.filter((s) => s.environment === "production").length, [sites]);
  const previewCount = useMemo(() => sites.filter((s) => s.environment === "preview").length, [sites]);
  const mcpCount = useMemo(() => sites.filter((s) => s.source === "mcp").length, [sites]);
  const defaultConsoleUrl = loginSite === "global" ? DEFAULT_INTL_CONSOLE : DEFAULT_CN_CONSOLE;

  const canQuickDeploy =
    authed && !switchingWorkspace && !deploying && Boolean(inspection?.valid);

  return (
    <div className="tako-page-sub flex flex-col" data-testid="webpage-panel">
      {/* Page Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-[var(--accent)] mb-1">
            腾讯云 EdgeOne Makers · 内置托管
          </div>
          <h1 className="text-[20px] font-semibold tracking-[-0.025em] text-[var(--text-primary)] leading-tight">
            网站托管 · Tako Web Page
          </h1>
          <p className="text-[12.5px] text-[var(--text-secondary)] mt-1">
            把本地网页或 AI 生成的网站一键发布到公网，集中管理上线记录、测速与环境变量。
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {sites.length > 0 && (
            <button
              type="button"
              data-testid="webpage-batch-health-btn"
              disabled={batchCheckingHealth}
              onClick={() => void handleBatchCheckHealth()}
              className={EXT_BUTTON}
              title="并发检测所有已上线站点的 HTTP 可达性与响应耗时"
            >
              {batchCheckingHealth ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
              ) : (
                <Activity className="h-3.5 w-3.5 text-[var(--success)]" />
              )}
              <span>{batchCheckingHealth ? "测速中..." : "批量测速"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className={EXT_BUTTON}
          >
            <HelpCircle className="h-3.5 w-3.5" />
            <span>使用说明</span>
          </button>
        </div>
      </div>

      {/* 1. Account & Runtime Status Bar (5 Complete States) */}
      <section
        data-testid="webpage-account-bar"
        className="tako-card-surface border border-[var(--border)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] px-[var(--density-card-px)] py-[var(--density-card-py)] flex flex-col gap-2.5"
      >
        {/* State B/C: Installing or Waiting Browser Authorization */}
        {authBusy && authProgress ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2 text-[12.5px]">
              <div className="flex items-center gap-2 min-w-0 font-medium text-[var(--text-primary)]">
                <Loader2 className="h-4 w-4 text-[var(--accent)] animate-spin shrink-0" />
                <span className="truncate">{authProgress.message}</span>
                {loggingIn && (
                  <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--text-secondary)] shrink-0">
                    {loginSite === "china" ? "中国站" : "国际站"}
                  </span>
                )}
              </div>
              <span className="text-[11px] font-mono text-[var(--text-muted)] tabular-nums shrink-0">
                {authProgress.percent}%
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-[var(--bg-subtle)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
                style={{ width: `${Math.max(8, Math.min(100, authProgress.percent))}%` }}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
              <div className="flex items-center gap-2">
                {authProgress.loginUrl && (
                  <>
                    <button
                      type="button"
                      onClick={() => void api.openUrl(authProgress.loginUrl!)}
                      className={EXT_BUTTON}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      <span>再次打开授权页</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyText("auth-url", authProgress.loginUrl!, "已复制授权链接")}
                      className={EXT_BUTTON}
                    >
                      {copiedKey === "auth-url" ? (
                        <Check className="h-3.5 w-3.5 text-[var(--success)]" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      <span>{copiedKey === "auth-url" ? "已复制 ✓" : "复制链接"}</span>
                    </button>
                  </>
                )}
              </div>
              {loggingIn && (
                <button
                  type="button"
                  onClick={() => void handleCancelLogin()}
                  className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-2 py-1 rounded-md hover:bg-[var(--bg-subtle)] cursor-pointer"
                >
                  取消登录
                </button>
              )}
            </div>
          </div>
        ) : authed ? (
          /* State D: Authenticated & Ready */
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--text-primary)]">
                  <span className="h-2 w-2 rounded-full bg-[var(--success)] shrink-0" />
                  <span>EdgeOne 已就绪</span>
                </span>
                <span className="text-[12px] text-[var(--text-secondary)] font-mono truncate">
                  {edgeOneStatus?.accountName || edgeOneStatus?.accountId || "已授权账号"}
                </span>
                {edgeOneStatus?.plan && (
                  <span className="text-[10.5px] font-medium px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
                    {edgeOneStatus.plan}
                  </span>
                )}
                {edgeOneStatus?.cliVersion && (
                  <span className="text-[10.5px] font-mono text-[var(--text-muted)]">
                    CLI v{edgeOneStatus.cliVersion}
                  </span>
                )}
                {edgeOneStatus?.checkedAt && (
                  <span className="text-[10.5px] text-[var(--text-muted)] hidden sm:inline">
                    · {edgeOneStatus.cached ? "缓存" : "已同步"} {formatRelativeTime(edgeOneStatus.checkedAt)}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={refreshingAccount || switchingWorkspace}
                  onClick={() => void handleManualRefresh()}
                  className={`${EXT_BUTTON} !h-7 !px-2 text-[11.5px]`}
                  title="并发刷新账号与工作空间信息"
                >
                  <RefreshCw className={`h-3 w-3 ${refreshingAccount ? "animate-spin" : ""}`} />
                  <span>刷新</span>
                </button>
                <ExtMoreDropdown
                  iconOnly
                  label="EdgeOne 账户与组件操作"
                  items={[
                    {
                      label: "更新 EdgeOne 组件",
                      icon: Download,
                      disabled: installingRuntime,
                      onClick: () => void handleUpgradeRuntime(),
                    },
                    {
                      label: "高级配置（Token / 默认项目名）",
                      icon: Settings2,
                      onClick: () => setAdvancedConfigOpen(true),
                    },
                    {
                      label: "打开 EdgeOne 控制台",
                      icon: ExternalLink,
                      onClick: () => void api.openUrl(defaultConsoleUrl),
                    },
                    {
                      label: loggingOut ? "退出中..." : "退出 EdgeOne 登录",
                      icon: LogOut,
                      danger: true,
                      disabled: loggingOut,
                      onClick: () => void handleLogout(),
                    },
                  ]}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--border)]">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <span className="text-[11.5px] text-[var(--text-secondary)] shrink-0">工作空间</span>
                {availableWorkspaces.length > 1 ? (
                  <div className="inline-flex items-center gap-1.5">
                    <select
                      aria-label="切换 EdgeOne 工作空间"
                      disabled={switchingWorkspace || deploying}
                      value={currentWsId ?? ""}
                      onChange={(e) => void handleSwitchWorkspace(e.target.value)}
                      className="h-7 px-2 rounded-[7px] border border-[var(--border)] bg-[var(--bg-canvas)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-50"
                    >
                      {availableWorkspaces.map((ws) => (
                        <option key={ws.id} value={ws.id}>
                          {ws.name} {ws.plan ? `(${ws.plan})` : ""}
                        </option>
                      ))}
                    </select>
                    {switchingWorkspace && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
                    )}
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[7px] bg-[var(--bg-subtle)] text-[12px] font-medium text-[var(--text-primary)]">
                    <Layers className="h-3 w-3 text-[var(--accent)]" />
                    <span>{edgeOneStatus?.workspaceName || currentWsId || "默认工作空间"}</span>
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11.5px] text-[var(--text-secondary)]">
                  允许 AI 通过 MCP 发布网站
                </span>
                <ToggleSwitch
                  checked={webPageEnabled}
                  disabled={savingMcp || !mcp}
                  ariaLabel="允许 AI 通过 MCP 发布网站"
                  data-testid="webpage-mcp-toggle"
                  onChange={(next) => void onToggleWebPage(next)}
                />
              </div>
            </div>
          </div>
        ) : (
          /* State A / E: Unlogged or Expired / Network Error */
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className={`h-8 w-8 rounded-[9px] inline-flex items-center justify-center shrink-0 ${
                    displayAuthError
                      ? "bg-[var(--warning-soft)] text-[var(--warning)]"
                      : "bg-[var(--accent-soft)] text-[var(--accent)]"
                  }`}
                >
                  {displayAuthError ? (
                    <AlertCircle className="h-4 w-4" />
                  ) : (
                    <Globe2 className="h-4 w-4" />
                  )}
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {displayAuthError
                      ? "EdgeOne 连接异常或登录已失效"
                      : "尚未登录腾讯云 EdgeOne"}
                  </div>
                  <div className="text-[11.5px] text-[var(--text-secondary)] truncate">
                    {displayAuthError
                      ? "本地站点记录仍完整保留，重新登录或重试后可继续部署。"
                      : "点击右侧登录，Tako 自动准备 Node 与部署组件，无需手动配置 CLI 或 Token。"}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <SegmentedControl
                  value={loginSite}
                  onChange={setLoginSite}
                  options={[
                    { id: "china", label: "中国站" },
                    { id: "global", label: "国际站" },
                  ]}
                />
                <button
                  type="button"
                  data-testid="webpage-login-btn"
                  onClick={() => void handleLogin()}
                  className={EXT_PRIMARY_BUTTON}
                >
                  <Globe2 className="h-3.5 w-3.5" />
                  <span>{displayAuthError ? "重新登录" : "浏览器一键登录"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAdvancedConfigOpen(true)}
                  className={EXT_BUTTON}
                  title="使用 API Token 静态鉴权"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  <span>Token</span>
                </button>
              </div>
            </div>

            {displayAuthError && (
              <div className="rounded-[8px] border border-[var(--warning-border)] bg-[var(--warning-soft)] px-3 py-2 text-[11.5px] text-[var(--warning)] flex items-center justify-between gap-2">
                <span className="min-w-0 break-words">{displayAuthError}</span>
                <button
                  type="button"
                  onClick={() => void handleManualRefresh()}
                  className="shrink-0 font-semibold underline cursor-pointer"
                >
                  重试检测
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 2. Quick Deploy Card (Drag & Drop + Native Picker + Live Streaming Progress) */}
      <section
        ref={deploySectionRef}
        data-testid="webpage-quick-deploy"
        className={`tako-card-surface border transition-all px-[var(--density-card-px)] py-[var(--density-card-py)] flex flex-col gap-3 ${
          dragHover
            ? "border-[var(--accent)] bg-[var(--accent-soft)]/50 ring-2 ring-[var(--accent-border)]"
            : "border-[var(--border)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Rocket className="h-4 w-4 text-[var(--accent)] shrink-0" />
            <h2 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
              快捷部署
            </h2>
            <span className="text-[11.5px] text-[var(--text-muted)] hidden sm:inline">
              支持拖入网站文件夹、单个 .html 或 .zip 包
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={deploying || inspecting}
              onClick={() => void handleCreateSampleSite()}
              className="h-7 px-2.5 rounded-[7px] border border-[var(--border)] bg-[var(--bg-subtle)]/70 hover:bg-[var(--bg-subtle)] text-[11.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1 transition cursor-pointer disabled:opacity-50"
              title="在本地自动创建一个精美演示页，方便快速测试一键部署"
            >
              <Sparkles className="h-3 w-3 text-[var(--accent)]" />
              <span>生成演示页</span>
            </button>
            <button
              type="button"
              onClick={() => setShowPathInput((v) => !v)}
              className="h-7 px-2 rounded-[7px] text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition cursor-pointer"
            >
              {showPathInput ? "收起路径输入" : "输入路径"}
            </button>
          </div>
        </div>

        {/* Dropzone / Selected Target / Live Progress */}
        {deploying && deployProgress ? (
          <div className="rounded-[10px] border border-[var(--accent-border)] bg-[var(--accent-soft)]/35 p-3.5 flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Loader2 className="h-4 w-4 text-[var(--accent)] animate-spin shrink-0" />
                <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
                  正在部署 {deployProgress.projectName || deployProjectName || "网站"}
                </span>
                <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)]">
                  {deployEnv === "production" ? "正式" : "预览"} · {deployArea === "global" ? "全球" : "海外"}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] font-mono text-[var(--text-secondary)] tabular-nums">
                  {(deployProgress.elapsedMs / 1000).toFixed(1)}s · {deployProgress.percent}%
                </span>
                <button
                  type="button"
                  onClick={() => void handleCancelDeploy()}
                  className="h-6 px-2 rounded-[6px] border border-[var(--border)] bg-[var(--bg-card)] hover:text-[var(--danger)] text-[11px] text-[var(--text-secondary)] cursor-pointer"
                >
                  取消
                </button>
              </div>
            </div>

            <div className="h-1.5 w-full rounded-full bg-[var(--bg-card)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
                style={{ width: `${Math.max(8, Math.min(100, deployProgress.percent))}%` }}
              />
            </div>

            <div className="flex items-center justify-between gap-2 text-[11.5px] text-[var(--text-secondary)]">
              <span className="truncate">{deployProgress.message}</span>
              <button
                type="button"
                onClick={() => setShowDeployLogs((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline shrink-0 cursor-pointer"
              >
                <Terminal className="h-3 w-3" />
                <span>{showDeployLogs ? "隐藏日志" : `实时日志 (${deployLogs.length})`}</span>
              </button>
            </div>

            {showDeployLogs && deployLogs.length > 0 && (
              <pre className="max-h-28 overflow-y-auto subtle-scroll rounded-[8px] border border-[var(--border)] bg-[var(--bg-canvas)] p-2.5 text-[10.5px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-all selectable">
                {deployLogs.join("\n")}
              </pre>
            )}
          </div>
        ) : lastDeployResult ? (
          <div
            data-testid="webpage-deploy-success"
            className="rounded-[10px] border border-[var(--success-border)] bg-[var(--success-soft)]/70 p-3.5 flex flex-col gap-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="h-5 w-5 rounded-full bg-[var(--success)] text-white inline-flex items-center justify-center shrink-0">
                  <Check className="h-3 w-3" strokeWidth={2.5} />
                </span>
                <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
                  {lastDeployResult.projectName} 部署成功
                </span>
                {lastDeployResult.durationMs ? (
                  <span className="text-[11px] text-[var(--text-secondary)] tabular-nums">
                    耗时 {(lastDeployResult.durationMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setLastDeployResult(null)}
                className="text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                继续部署其他站点
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] bg-[var(--bg-card)] border border-[var(--border)] px-3 py-2">
              <button
                type="button"
                onClick={() => void api.openUrl(lastDeployResult.url)}
                className="text-[12px] font-mono font-medium text-[var(--accent)] hover:underline truncate text-left cursor-pointer"
              >
                {lastDeployResult.url}
              </button>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => void api.openUrl(lastDeployResult.url)}
                  className={EXT_PRIMARY_BUTTON}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>打开站点</span>
                </button>
                <button
                  type="button"
                  onClick={() => void copyText("last-url", lastDeployResult.url, "已复制公网链接")}
                  className={EXT_BUTTON}
                >
                  {copiedKey === "last-url" ? (
                    <Check className="h-3.5 w-3.5 text-[var(--success)]" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  <span>{copiedKey === "last-url" ? "已复制" : "复制"}</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setQrModalSite({
                      title: lastDeployResult.projectName,
                      url: lastDeployResult.url,
                    })
                  }
                  className={EXT_BUTTON}
                  title="手机扫码预览"
                >
                  <QrCode className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {!inspection ? (
              <div
                className={`rounded-[10px] border border-dashed px-4 py-4 flex flex-wrap items-center justify-between gap-3 transition ${
                  dragHover
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]/50"
                    : "border-[var(--border-strong)] bg-[var(--bg-subtle)]/45"
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="h-9 w-9 rounded-[9px] bg-[var(--bg-card)] border border-[var(--border)] text-[var(--accent)] inline-flex items-center justify-center shrink-0">
                    <Upload className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                      {dragHover ? "松开鼠标即可识别待部署站点" : "拖拽网站文件夹、HTML 或 ZIP 到窗口内"}
                    </div>
                    <div className="text-[11.5px] text-[var(--text-muted)]">
                      自动补齐单 HTML 入口并智能命名，全程本地打包直传 EdgeOne
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    data-testid="webpage-pick-folder-btn"
                    disabled={inspecting}
                    onClick={() => void handlePickSource("folder")}
                    className={EXT_BUTTON}
                  >
                    <Folder className="h-3.5 w-3.5 text-[var(--accent)]" />
                    <span>选择文件夹</span>
                  </button>
                  <button
                    type="button"
                    data-testid="webpage-pick-file-btn"
                    disabled={inspecting}
                    onClick={() => void handlePickSource("file")}
                    className={EXT_BUTTON}
                  >
                    <FileCode2 className="h-3.5 w-3.5" />
                    <span>HTML / ZIP</span>
                  </button>
                </div>
              </div>
            ) : (
              /* Selected & Inspected Source Ready to Deploy */
              <div className="rounded-[10px] border border-[var(--accent-border)] bg-[var(--bg-subtle)]/45 p-3 flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="h-8 w-8 rounded-[8px] bg-[var(--accent-soft)] text-[var(--accent)] inline-flex items-center justify-center shrink-0">
                      {inspection.kind === "folder" ? (
                        <Folder className="h-4 w-4" />
                      ) : (
                        <FileCode2 className="h-4 w-4" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[12.5px] font-semibold text-[var(--text-primary)] truncate">
                          {inspection.name}
                        </span>
                        <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] shrink-0 tabular-nums">
                          {inspection.fileCount} 个文件 · {formatFileSize(inspection.totalBytes)}
                        </span>
                        {inspection.linkedProjectName && (
                          <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--success-soft)] text-[var(--success)] shrink-0">
                            已关联项目
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-[var(--text-muted)] truncate">
                        {compactPath(inspection.path)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handlePickSource("folder")}
                      className={`${EXT_BUTTON} !h-7 !px-2 text-[11px]`}
                    >
                      更换目录
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInspection(null);
                        setDeployError(null);
                      }}
                      className="h-7 w-7 rounded-[7px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] inline-flex items-center justify-center cursor-pointer"
                      aria-label="清除已选目录"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Inline Deploy Options */}
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--border)]">
                  <input
                    type="text"
                    aria-label="项目名称"
                    value={deployProjectName}
                    onChange={(e) => setDeployProjectName(e.target.value)}
                    placeholder="项目名（留空自动生成）"
                    className="h-[var(--density-ctrl-h)] min-w-[150px] flex-1 rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] px-2.5 text-[12px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  />
                  <SegmentedControl
                    value={deployEnv}
                    onChange={setDeployEnv}
                    options={[
                      { id: "production", label: "正式" },
                      { id: "preview", label: "预览" },
                    ]}
                  />
                  <button
                    type="button"
                    onClick={() => setDeployAdvancedOpen((v) => !v)}
                    className={`${EXT_BUTTON} !px-2 text-[11.5px]`}
                    title="展开加速区域设置"
                  >
                    <span>{deployArea === "global" ? "全球" : "海外"}</span>
                    <ChevronDown className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    data-testid="webpage-deploy-submit-btn"
                    disabled={!canQuickDeploy}
                    onClick={() =>
                      void runDeploy({
                        path: inspection.path,
                        projectName: deployProjectName,
                        environment: deployEnv,
                        area: deployArea,
                      })
                    }
                    className={EXT_PRIMARY_BUTTON}
                  >
                    <Rocket className="h-3.5 w-3.5" />
                    <span>立即发布上线</span>
                  </button>
                </div>

                {deployAdvancedOpen && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] bg-[var(--bg-card)] border border-[var(--border)] px-3 py-2 text-[11.5px]">
                    <span className="text-[var(--text-secondary)]">
                      加速区域（仅创建新项目时生效，与登录站点独立）
                    </span>
                    <SegmentedControl
                      value={deployArea}
                      onChange={setDeployArea}
                      options={[
                        { id: "global", label: "全球加速" },
                        { id: "overseas", label: "海外加速" },
                      ]}
                    />
                  </div>
                )}

                {inspection.warning && (
                  <div className="text-[11px] text-[var(--warning)] flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    <span>{inspection.warning}</span>
                  </div>
                )}
              </div>
            )}

            {showPathInput && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleInspectPath(pathDraft);
                }}
                className="flex items-center gap-2"
              >
                <input
                  type="text"
                  value={pathDraft}
                  onChange={(e) => setPathDraft(e.target.value)}
                  placeholder="粘贴本地路径，例如 ~/Sites/portfolio 或 ~/Desktop/index.html"
                  className={`${EXT_INPUT} font-mono`}
                />
                <button
                  type="submit"
                  disabled={inspecting || !pathDraft.trim()}
                  className={EXT_BUTTON}
                >
                  {inspecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "识别"}
                </button>
              </form>
            )}
          </div>
        )}

        {deployError && (
          <div
            role="alert"
            className="rounded-[8px] border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-[12px] text-[var(--danger)] flex items-start justify-between gap-2"
          >
            <div className="flex items-start gap-2 min-w-0">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span className="break-words">{deployError}</span>
            </div>
            <button
              type="button"
              onClick={() => setDeployError(null)}
              className="shrink-0 cursor-pointer"
              aria-label="关闭部署错误"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </section>

      {/* 3. Deployed Sites Management Section */}
      <section className="flex flex-col gap-2.5 min-w-0" data-testid="webpage-sites-section">
        <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
          <div className="flex items-center gap-2">
            <h2 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
              已上线站点
            </h2>
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--bg-subtle)] text-[var(--text-secondary)] tabular-nums">
              {sites.length} 个站点
            </span>
            {prodCount > 0 && (
              <span className="text-[11px] text-[var(--text-muted)] hidden sm:inline tabular-nums">
                正式 {prodCount} · 预览 {previewCount}
                {mcpCount > 0 ? ` · AI 发布 ${mcpCount}` : ""}
              </span>
            )}
          </div>

          {sites.length > 0 && (
            <div className="flex items-center gap-1.5">
              <select
                aria-label="站点来源筛选"
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value as "all" | "ui" | "mcp")}
                className="h-7 px-2 rounded-[7px] border border-[var(--border)] bg-[var(--bg-card)] text-[11.5px] text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]"
              >
                <option value="all">全部来源</option>
                <option value="ui">页面部署</option>
                <option value="mcp">AI MCP 发布</option>
              </select>
              <select
                aria-label="站点排序方式"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as "recent" | "name" | "count")}
                className="h-7 px-2 rounded-[7px] border border-[var(--border)] bg-[var(--bg-card)] text-[11.5px] text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]"
              >
                <option value="recent">最近部署</option>
                <option value="count">部署次数</option>
                <option value="name">项目名称</option>
              </select>
            </div>
          )}
        </div>

        {/* Search & Environment Filter Toolbar */}
        {sites.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="ext-button flex flex-1 min-w-[180px] items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-2.5 text-[var(--text-muted)] focus-within:border-[var(--accent)]">
              <Search className="h-3.5 w-3.5 shrink-0" />
              <input
                type="text"
                data-testid="webpage-sites-search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索项目名、URL、备注或本地路径..."
                className="min-w-0 w-full bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="shrink-0 cursor-pointer"
                  aria-label="清空站点搜索"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </label>
            <SegmentedControl
              value={envFilter}
              onChange={setEnvFilter}
              options={[
                { id: "all", label: "全部" },
                { id: "production", label: "正式" },
                { id: "preview", label: "预览" },
              ]}
            />
          </div>
        )}

        {/* Sites List or Empty States */}
        {sites.length === 0 ? (
          <div className="tako-card-surface border border-[var(--border)] bg-[var(--bg-card)] px-6 py-8 flex flex-col items-center text-center gap-3">
            <span className="h-11 w-11 rounded-[12px] bg-[var(--accent-soft)] text-[var(--accent)] inline-flex items-center justify-center">
              <Globe2 className="h-5 w-5" />
            </span>
            <div className="max-w-[440px]">
              <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                {authed ? "还没有上线站点" : "登录 EdgeOne，开启一键网站托管"}
              </h3>
              <p className="text-[12px] text-[var(--text-secondary)] mt-1 leading-relaxed">
                {authed
                  ? "把文件夹、单个 HTML 或 ZIP 拖到上方即可秒级发布；也可以直接在 Claude / Codex / WorkBuddy 中对 AI 说："
                  : "完成腾讯云 EdgeOne 授权后，在这里拖入目录即可发布，AI 助手发布的网站也会自动同步到此列表。"}
              </p>
            </div>
            {authed ? (
              <>
                <button
                  type="button"
                  onClick={() => void copyText("ai-prompt", AI_PROMPT_SNIPPET, "已复制 AI 部署口令")}
                  className="rounded-[9px] border border-[var(--accent-border)] bg-[var(--accent-soft)]/70 hover:bg-[var(--accent-soft)] px-3.5 py-2 text-[12px] font-medium text-[var(--accent)] inline-flex items-center gap-2 transition cursor-pointer"
                  title="点击复制，直接粘贴给 Claude / Codex"
                >
                  <span>「{AI_PROMPT_SNIPPET}」</span>
                  {copiedKey === "ai-prompt" ? (
                    <Check className="h-3.5 w-3.5 text-[var(--success)]" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void handlePickSource("folder")}
                    className={EXT_PRIMARY_BUTTON}
                  >
                    <Folder className="h-3.5 w-3.5" />
                    <span>选择文件夹部署</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCreateSampleSite()}
                    className={EXT_BUTTON}
                  >
                    <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
                    <span>生成演示页体验</span>
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                disabled={authBusy}
                onClick={() => void handleLogin()}
                className={EXT_PRIMARY_BUTTON}
              >
                <Globe2 className="h-3.5 w-3.5" />
                <span>立即浏览器一键登录</span>
              </button>
            )}
          </div>
        ) : filteredSites.length === 0 ? (
          <div className="tako-card-surface border border-[var(--border)] bg-[var(--bg-card)] px-6 py-8 flex flex-col items-center gap-2 text-center">
            <Search className="h-5 w-5 text-[var(--text-muted)]" />
            <div className="text-[12.5px] text-[var(--text-secondary)]">
              没有符合当前筛选条件的站点
            </div>
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                setEnvFilter("all");
                setSourceFilter("all");
              }}
              className="text-[12px] font-medium text-[var(--accent)] hover:underline cursor-pointer"
            >
              清空筛选条件
            </button>
          </div>
        ) : (
          <div className="tako-card-surface border border-[var(--border)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] divide-y divide-[var(--border)] overflow-hidden">
            {filteredSites.map((site) => {
              const health = healthMap[site.url];
              const checkingThis = Boolean(checkingHealthIds[site.id]);
              const isRedeploying = redeployingSiteId === site.id;
              const historyOpen = expandedHistoryId === site.id;
              const altEnv: "production" | "preview" =
                site.environment === "production" ? "preview" : "production";
              const siteConsoleUrl = site.consoleUrl || defaultConsoleUrl;

              return (
                <div
                  key={site.id}
                  data-testid={`webpage-site-row-${site.projectName}`}
                  className="px-[var(--density-card-px)] py-[var(--density-card-py)] flex flex-col gap-2 hover:bg-[var(--bg-subtle)]/35 transition-colors"
                >
                  {/* Tier 1: Name + Badges + Health + Time */}
                  <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                      <button
                        type="button"
                        onClick={() => void handleTogglePin(site)}
                        title={site.pinned ? "取消置顶" : "置顶该站点"}
                        aria-label={site.pinned ? `取消置顶 ${site.projectName}` : `置顶 ${site.projectName}`}
                        className={`h-6 w-6 rounded-md inline-flex items-center justify-center shrink-0 transition cursor-pointer ${
                          site.pinned
                            ? "text-[var(--warning)] bg-[var(--warning-soft)]"
                            : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)]"
                        }`}
                      >
                        <Pin className="h-3.5 w-3.5" />
                      </button>

                      <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
                        {site.projectName}
                      </span>

                      <StatusPill tone={site.environment === "production" ? "ok" : "warn"}>
                        {site.environment === "production" ? "正式" : "预览"}
                      </StatusPill>

                      <span
                        className={`text-[10.5px] font-medium px-1.5 py-0.5 rounded-[5px] shrink-0 ${
                          site.source === "mcp"
                            ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                            : "bg-[var(--bg-subtle)] text-[var(--text-secondary)]"
                        }`}
                      >
                        {site.source === "mcp" ? "AI MCP" : "页面部署"}
                      </span>

                      {site.deployCount > 1 && (
                        <span className="text-[10.5px] text-[var(--text-muted)] tabular-nums shrink-0">
                          第 {site.deployCount} 次
                        </span>
                      )}

                      {health && (
                        <span
                          className={`inline-flex items-center gap-1 text-[10.5px] font-mono px-1.5 py-0.5 rounded-[5px] shrink-0 ${
                            health.reachable
                              ? "bg-[var(--success-soft)] text-[var(--success)]"
                              : "bg-[var(--danger-soft)] text-[var(--danger)]"
                          }`}
                          title={`上次探测：${formatDateTime(health.checkedAt)}`}
                        >
                          <Activity className="h-2.5 w-2.5" />
                          {health.reachable
                            ? `${health.statusCode ?? 200} · ${health.latencyMs}ms`
                            : health.error || "不可达"}
                        </span>
                      )}

                      {site.note && (
                        <span
                          className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--bg-subtle)] text-[var(--text-secondary)] truncate max-w-[200px]"
                          title={site.note}
                        >
                          {site.note}
                        </span>
                      )}
                    </div>

                    <span
                      className="text-[11px] text-[var(--text-muted)] shrink-0 tabular-nums"
                      title={formatDateTime(site.deployedAt)}
                    >
                      {formatRelativeTime(site.deployedAt)}
                    </span>
                  </div>

                  {/* Tier 2: URL + Local Source Info + Actions */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pl-7 min-w-0">
                    <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <button
                          type="button"
                          onClick={() => void api.openUrl(site.url)}
                          className="text-[12px] font-mono text-[var(--accent)] hover:underline truncate text-left cursor-pointer"
                          title={site.url}
                        >
                          {site.url}
                        </button>
                        <button
                          type="button"
                          onClick={() => void copyText(`copy-${site.id}`, site.url, "已复制站点链接")}
                          className="h-5 w-5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] inline-flex items-center justify-center shrink-0 cursor-pointer"
                          title="复制公网链接"
                          aria-label={`复制 ${site.projectName} 链接`}
                        >
                          {copiedKey === `copy-${site.id}` ? (
                            <Check className="h-3 w-3 text-[var(--success)]" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => setQrModalSite({ title: site.projectName, url: site.url })}
                          className="h-5 w-5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] inline-flex items-center justify-center shrink-0 cursor-pointer"
                          title="手机扫码预览"
                          aria-label={`${site.projectName} 二维码`}
                        >
                          <QrCode className="h-3 w-3" />
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--text-muted)] min-w-0">
                        {site.localSourcePath ? (
                          site.localSourceExists ? (
                            <span className="truncate font-mono" title={site.localSourcePath}>
                              本机源：{compactPath(site.localSourcePath)}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-[var(--warning)]">
                              <span>本地目录已移动或不存在</span>
                              <button
                                type="button"
                                onClick={() => void handleRebindFolder(site)}
                                className="underline font-medium cursor-pointer"
                              >
                                重新关联
                              </button>
                            </span>
                          )
                        ) : (
                          <span>未关联本机源目录</span>
                        )}
                        {site.workspaceName && (
                          <span className="shrink-0">· {site.workspaceName}</span>
                        )}
                      </div>
                    </div>

                    {/* Right Action Buttons */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => void api.openUrl(site.url)}
                        className={`${EXT_BUTTON} !h-7 !px-2.5 text-[11.5px]`}
                      >
                        <ExternalLink className="h-3 w-3" />
                        <span>打开</span>
                      </button>

                      {site.localSourcePath && site.localSourceExists ? (
                        <button
                          type="button"
                          disabled={deploying || !authed || switchingWorkspace}
                          onClick={() =>
                            void runDeploy({
                              path: site.localSourcePath!,
                              projectName: site.projectName,
                              environment: site.environment === "preview" ? "preview" : "production",
                              area: site.area === "overseas" ? "overseas" : "global",
                              redeploySiteId: site.id,
                            })
                          }
                          className="h-7 px-2.5 rounded-[8px] border border-[var(--accent-border)] bg-[var(--accent-soft)] hover:bg-[var(--accent-border)] text-[var(--accent)] text-[11.5px] font-semibold inline-flex items-center gap-1 transition cursor-pointer disabled:opacity-45"
                          title={`使用本机目录重新部署到${site.environment === "preview" ? "预览" : "正式"}环境`}
                        >
                          <RefreshCw className={`h-3 w-3 ${isRedeploying ? "animate-spin" : ""}`} />
                          <span>{isRedeploying ? "部署中" : "重新部署"}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void api.openUrl(siteConsoleUrl)}
                          className={`${EXT_BUTTON} !h-7 !px-2.5 text-[11.5px]`}
                        >
                          <span>控制台</span>
                        </button>
                      )}

                      <ExtMoreDropdown
                        iconOnly
                        label={`${site.projectName} 更多操作`}
                        items={[
                          {
                            label: checkingThis ? "探测中..." : "检测可访问性与耗时",
                            icon: Activity,
                            disabled: checkingThis,
                            onClick: () => void handleCheckSingleHealth(site),
                          },
                          ...(site.localSourcePath && site.localSourceExists
                            ? [
                                {
                                  label: `发布到${altEnv === "preview" ? "预览版" : "正式版"}`,
                                  icon: Rocket,
                                  disabled: deploying || !authed,
                                  onClick: () =>
                                    void runDeploy({
                                      path: site.localSourcePath!,
                                      projectName: site.projectName,
                                      environment: altEnv,
                                      area: site.area === "overseas" ? "overseas" : "global",
                                      redeploySiteId: site.id,
                                    }),
                                },
                                {
                                  label: "在本地打开源目录",
                                  icon: FolderOpen,
                                  onClick: () =>
                                    void api
                                      .openLocalPath(site.localSourcePath!)
                                      .catch((err) => setActionError(String(err))),
                                },
                                {
                                  label: "环境变量管理 (env)",
                                  icon: Settings2,
                                  disabled: !authed,
                                  onClick: () => openEnvDrawer(site),
                                },
                              ]
                            : []),
                          {
                            label: "重新关联本地目录",
                            icon: Folder,
                            onClick: () => void handleRebindFolder(site),
                          },
                          {
                            label: historyOpen
                              ? "收起部署历史"
                              : `部署历史 (${site.history.length})`,
                            icon: History,
                            onClick: () =>
                              setExpandedHistoryId(historyOpen ? null : site.id),
                          },
                          {
                            label: site.note ? "修改备注" : "添加备注",
                            icon: StickyNote,
                            onClick: () => {
                              setNoteTarget(site);
                              setNoteDraft(site.note ?? "");
                            },
                          },
                          {
                            label: site.pinned ? "取消置顶" : "置顶站点",
                            icon: site.pinned ? PinOff : Pin,
                            onClick: () => void handleTogglePin(site),
                          },
                          {
                            label: "在 EdgeOne 控制台管理",
                            icon: ExternalLink,
                            onClick: () => void api.openUrl(siteConsoleUrl),
                          },
                          {
                            label: "移除本地记录",
                            icon: Trash2,
                            danger: true,
                            onClick: () => setRemoveTarget(site),
                          },
                        ]}
                      />
                    </div>
                  </div>

                  {/* Expandable Deployment History */}
                  {historyOpen && (
                    <div className="ml-7 mt-1 rounded-[9px] border border-[var(--border)] bg-[var(--bg-canvas)] p-2.5 flex flex-col gap-1.5">
                      <div className="flex items-center justify-between text-[11px] font-semibold text-[var(--text-secondary)]">
                        <span className="inline-flex items-center gap-1.5">
                          <Clock className="h-3 w-3" />
                          部署历史（最近 {site.history.length} 次）
                        </span>
                        <button
                          type="button"
                          onClick={() => setExpandedHistoryId(null)}
                          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                        >
                          收起
                        </button>
                      </div>
                      <div className="divide-y divide-[var(--border)]">
                        {site.history.map((dep, idx) => (
                          <div
                            key={`${dep.id}-${idx}`}
                            className="py-1.5 flex flex-wrap items-center justify-between gap-2 text-[11.5px]"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`h-2 w-2 rounded-full shrink-0 ${
                                  idx === 0 ? "bg-[var(--success)]" : "bg-[var(--border-strong)]"
                                }`}
                              />
                              <span className="font-mono text-[var(--text-secondary)] tabular-nums">
                                {formatDateTime(dep.deployedAt)}
                              </span>
                              <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--text-secondary)]">
                                {dep.environment === "production" ? "正式" : "预览"} ·{" "}
                                {dep.area === "overseas" ? "海外" : "全球"} ·{" "}
                                {dep.source === "mcp" ? "AI MCP" : "页面"}
                              </span>
                              {dep.durationMs ? (
                                <span className="text-[10.5px] text-[var(--text-muted)] tabular-nums">
                                  {(dep.durationMs / 1000).toFixed(1)}s
                                </span>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={() => void api.openUrl(dep.url)}
                                className="text-[11px] text-[var(--accent)] hover:underline cursor-pointer"
                              >
                                打开
                              </button>
                              <button
                                type="button"
                                onClick={() => void copyText(`dep-${dep.id}`, dep.url, "已复制该版本链接")}
                                className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                              >
                                复制
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Local SVG QR Preview Modal (100% CSP Compliant) */}
      {qrModalSite && (
        <div
          className="fixed inset-0 z-50 modal-backdrop flex items-center justify-center p-4"
          onClick={() => setQrModalSite(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[300px] rounded-[14px] border border-[var(--border)] bg-[var(--bg-card)] shadow-[var(--shadow-modal)] p-4 flex flex-col items-center text-center gap-3"
          >
            <div className="w-full flex items-center justify-between">
              <span className="text-[13.5px] font-semibold text-[var(--text-primary)] truncate">
                扫码预览 · {qrModalSite.title}
              </span>
              <button
                type="button"
                onClick={() => setQrModalSite(null)}
                className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] cursor-pointer"
                aria-label="关闭二维码预览"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-2.5 rounded-[12px] border border-[var(--border)] bg-white">
              <LocalQrSvg url={qrModalSite.url} size={168} />
            </div>
            <div className="text-[11px] font-mono text-[var(--text-secondary)] break-all selectable">
              {qrModalSite.url}
            </div>
            <div className="w-full flex items-center gap-2">
              <button
                type="button"
                onClick={() => void copyText("qr-copy", qrModalSite.url, "已复制公网链接")}
                className={`${EXT_BUTTON} flex-1`}
              >
                <Copy className="h-3.5 w-3.5" />
                <span>{copiedKey === "qr-copy" ? "已复制 ✓" : "复制链接"}</span>
              </button>
              <button
                type="button"
                onClick={() => void api.openUrl(qrModalSite.url)}
                className={`${EXT_PRIMARY_BUTTON} flex-1`}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span>打开</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Advanced Config Drawer (API Token & Default Project Name) */}
      {advancedConfigOpen && (
        <ExtSlideDrawer
          title="EdgeOne 高级配置"
          onClose={() => setAdvancedConfigOpen(false)}
          busy={savingMcp}
          footer={
            <>
              <button
                type="button"
                className={EXT_BUTTON}
                onClick={() => setAdvancedConfigOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={savingMcp}
                onClick={() => void handleSaveAdvanced()}
                className={EXT_PRIMARY_BUTTON}
              >
                {savingMcp ? "保存中..." : "保存配置"}
              </button>
            </>
          }
        >
          <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">
            普通使用推荐直接「浏览器一键登录」；以下配置仅适用于 CI/CD 静态 Token 或希望固定默认部署项目名的场景。
          </p>
          <label className="ext-field">
            <span>EDGEONE_PAGES_API_TOKEN（可选）</span>
            <input
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder="留空则使用浏览器登录态"
              className={`${EXT_INPUT} font-mono`}
            />
          </label>
          <label className="ext-field">
            <span>默认项目名（可选）</span>
            <input
              type="text"
              value={defaultProjectDraft}
              onChange={(e) => setDefaultProjectDraft(e.target.value)}
              placeholder="例如 portfolio-site（留空自动根据目录名生成）"
              className={`${EXT_INPUT} font-mono`}
            />
          </label>
          <div className="rounded-[9px] border border-[var(--border)] bg-[var(--bg-subtle)]/60 p-3 text-[11.5px] text-[var(--text-secondary)] leading-relaxed">
            提示：删除云端项目、绑定自定义域名等账户级操作需前往{" "}
            <button
              type="button"
              onClick={() => void api.openUrl(defaultConsoleUrl)}
              className="text-[var(--accent)] font-medium hover:underline cursor-pointer"
            >
              腾讯云 EdgeOne 控制台
            </button>{" "}
            完成。
          </div>
        </ExtSlideDrawer>
      )}

      {/* Environment Variables Drawer (Real `edgeone makers env` integration) */}
      {envSite && (
        <ExtSlideDrawer
          title={`环境变量 · ${envSite.projectName}`}
          onClose={() => setEnvSite(null)}
          busy={envBusy}
          footer={
            <button
              type="button"
              disabled={envBusy || envLoading}
              onClick={() => void handlePullEnvVars()}
              className={EXT_BUTTON}
            >
              <Download className="h-3.5 w-3.5" />
              <span>拉取至本地 .env</span>
            </button>
          }
        >
          <div className="flex items-center justify-between gap-2">
            <SegmentedControl
              value={envTab}
              onChange={(next) => {
                setEnvTab(next);
                void loadEnvVars(envSite, next);
              }}
              options={[
                { id: "production", label: "正式环境" },
                { id: "preview", label: "预览环境" },
              ]}
            />
            <button
              type="button"
              disabled={envLoading || envBusy}
              onClick={() => void loadEnvVars(envSite, envTab)}
              className={`${EXT_BUTTON} !h-7 !px-2 text-[11px]`}
            >
              <RefreshCw className={`h-3 w-3 ${envLoading ? "animate-spin" : ""}`} />
              <span>刷新</span>
            </button>
          </div>

          {envError && (
            <div className="rounded-[8px] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-2.5 text-[11.5px] text-[var(--danger)] break-words">
              {envError}
            </div>
          )}

          {/* Add Variable Form */}
          <div className="rounded-[9px] border border-[var(--border)] bg-[var(--bg-subtle)]/50 p-3 flex flex-col gap-2">
            <div className="text-[11.5px] font-semibold text-[var(--text-primary)]">
              新增 / 更新环境变量
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                value={envNewKey}
                onChange={(e) => setEnvNewKey(e.target.value)}
                placeholder="KEY（如 API_BASE_URL）"
                className={`${EXT_INPUT} font-mono`}
              />
              <input
                type="text"
                value={envNewVal}
                onChange={(e) => setEnvNewVal(e.target.value)}
                placeholder="VALUE"
                className={`${EXT_INPUT} font-mono`}
              />
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                disabled={envBusy || !envNewKey.trim()}
                onClick={() => void handleAddEnvVar()}
                className={`${EXT_PRIMARY_BUTTON} !h-7 !px-2.5 text-[11.5px]`}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{envBusy ? "写入中..." : "写入变量"}</span>
              </button>
            </div>
          </div>

          {/* Variables List */}
          {envLoading ? (
            <div className="py-10 flex items-center justify-center gap-2 text-[12px] text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>正在从 EdgeOne 读取环境变量...</span>
            </div>
          ) : envVars.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-[var(--text-muted)] border border-dashed border-[var(--border)] rounded-[9px]">
              当前{envTab === "production" ? "正式" : "预览"}环境暂无环境变量
            </div>
          ) : (
            <div className="rounded-[9px] border border-[var(--border)] divide-y divide-[var(--border)] overflow-hidden">
              {envVars.map((v) => (
                <div
                  key={`${v.key}-${v.environment}`}
                  className="px-3 py-2 flex items-center justify-between gap-2 text-[12px]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono font-semibold text-[var(--text-primary)] truncate">
                      {v.key}
                    </div>
                    <div className="font-mono text-[11px] text-[var(--text-muted)] truncate">
                      {v.value || "(已隐藏或空值)"}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={envBusy}
                    onClick={() => void handleRemoveEnvVar(v.key)}
                    className="h-7 w-7 rounded-md text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--danger-soft)] inline-flex items-center justify-center shrink-0 cursor-pointer disabled:opacity-40"
                    title={`删除 ${v.key}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </ExtSlideDrawer>
      )}

      {/* Note Edit Modal */}
      {noteTarget && (
        <div
          className="fixed inset-0 z-50 modal-backdrop flex items-center justify-center p-4"
          onClick={() => setNoteTarget(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[380px] rounded-[14px] border border-[var(--border)] bg-[var(--bg-card)] shadow-[var(--shadow-modal)] p-4 flex flex-col gap-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                编辑备注 · {noteTarget.projectName}
              </h3>
              <button
                type="button"
                onClick={() => setNoteTarget(null)}
                className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <input
              type="text"
              autoFocus
              maxLength={160}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSaveNote();
              }}
              placeholder="例如：给客户展示的 V2 落地页"
              className={EXT_INPUT}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className={EXT_BUTTON} onClick={() => setNoteTarget(null)}>
                取消
              </button>
              <button
                type="button"
                disabled={savingNote}
                className={EXT_PRIMARY_BUTTON}
                onClick={() => void handleSaveNote()}
              >
                {savingNote ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove Local Record Confirm Modal */}
      {removeTarget && (
        <div
          className="fixed inset-0 z-50 modal-backdrop flex items-center justify-center p-4"
          onClick={() => setRemoveTarget(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[380px] rounded-[14px] border border-[var(--border)] bg-[var(--bg-card)] shadow-[var(--shadow-modal)] p-4 flex flex-col gap-3"
          >
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
              移除本地站点记录？
            </h3>
            <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">
              将从本机列表中移除 <strong className="text-[var(--text-primary)]">{removeTarget.projectName}</strong> 的部署记录与历史。
              <br />
              该操作<strong>不会删除</strong>腾讯云 EdgeOne 上的线上站点；如需下线或删除云端项目，请前往 EdgeOne 控制台。
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className={EXT_BUTTON} onClick={() => setRemoveTarget(null)}>
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmRemoveSite()}
                className="ext-button inline-flex items-center gap-1.5 rounded-lg border border-[var(--danger)]/35 bg-[var(--danger-soft)] px-3 text-[12px] font-semibold text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white transition cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>确认移除记录</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Usage Guide Modal */}
      {helpOpen && (
        <div
          className="fixed inset-0 z-50 modal-backdrop flex items-center justify-center p-4"
          onClick={() => setHelpOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[440px] rounded-[14px] border border-[var(--border)] bg-[var(--bg-card)] shadow-[var(--shadow-modal)] overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe2 className="h-4 w-4 text-[var(--accent)]" />
                <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
                  网站托管 · 使用说明
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 flex flex-col gap-3 text-[12px] text-[var(--text-secondary)] leading-relaxed">
              <ol className="list-decimal pl-4 space-y-2">
                <li>
                  <strong className="text-[var(--text-primary)]">一次授权，自动托管环境</strong>：点击「浏览器一键登录」后，Tako 自动维护内置 Node 与 EdgeOne 组件，本地缓存状态，打开即用不卡顿。
                </li>
                <li>
                  <strong className="text-[var(--text-primary)]">拖放快捷部署 & 一键重部署</strong>：支持拖拽网站目录、单个 HTML 或 ZIP 包；发布后自动沉淀到下方站点列表，支持手机扫码预览、并发测速、预览/正式环境切换与环境变量管理。
                </li>
                <li>
                  <strong className="text-[var(--text-primary)]">AI 对话联动</strong>：开启「允许 AI 通过 MCP 发布网站」后，在 Claude / Codex / Antigravity / WorkBuddy 中一句话发布的网站也会自动同步到此页面。
                </li>
              </ol>
              <p className="text-[11px] text-[var(--text-muted)]">
                说明：自定义域名绑定和删除线上项目请通过站点菜单「在 EdgeOne 控制台管理」完成。
              </p>
            </div>
            <div className="px-4 py-2.5 border-t border-[var(--border)] flex justify-end">
              <button type="button" className={EXT_PRIMARY_BUTTON} onClick={() => setHelpOpen(false)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
