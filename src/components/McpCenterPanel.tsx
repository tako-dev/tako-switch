import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Film,
  Globe,
  Globe2,
  Headphones,
  Image as ImageIcon,
  Layers,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  Sparkles,
  UserCheck,
  X,
} from "lucide-react";
import {
  api,
  type EdgeOneProgressEvent,
  type EdgeOneStatus,
  type McpToolsConfig,
} from "../lib/api";
import { McpInlineTheater, type McpToolKey } from "./McpInlineTheater";
import { StatusPill, ToggleSwitch } from "./UiPrimitives";

interface McpCardSpec {
  key: McpToolKey;
  mcpToolAttr: string;
  title: string;
  description: string;
  Icon: typeof ImageIcon;
}

const CORE_MCP_CARDS: McpCardSpec[] = [
  {
    key: "image",
    mcpToolAttr: "tako_generate_image",
    title: "图像生成",
    description: "文字生图、局部改图与多图融合。",
    Icon: ImageIcon,
  },
  {
    key: "video",
    mcpToolAttr: "tako_generate_video",
    title: "视频生成",
    description: "首尾帧控制与高质感动态生视频成片。",
    Icon: Film,
  },
  {
    key: "audio",
    mcpToolAttr: "tako_generate_audio",
    title: "声音生成",
    description: "多角色、多情绪自然语音旁白。",
    Icon: Headphones,
  },
  {
    key: "search",
    mcpToolAttr: "tako_web_search",
    title: "联网搜索",
    description: "实时权威信源检索与引用溯源。",
    Icon: Globe,
  },
  {
    key: "consult",
    mcpToolAttr: "tako_consult",
    title: "多模型会诊",
    description: "邀请第二外脑模型独立审阅与交叉判断。",
    Icon: Brain,
  },
];

interface McpCenterPanelProps {
  mcp: McpToolsConfig | null;
  savingMcp: boolean;
  loggedIn: boolean;
  loggingIn: boolean;
  initialDrawerTab?: McpToolKey | null;
  onConsumeInitialTab?: () => void;
  onGoHome: () => void;
  onToggleCoreTool: (key: McpToolKey) => void;
  onToggleWebPage: (next: boolean) => Promise<void>;
  onSaveEdgeOneConfig: (token: string, projectName: string) => Promise<void>;
  onSelectConsultModel: (model: string) => void;
  onRequestLogin: () => void;
  onEdgeOneChanged?: () => void;
  onNotify?: (msg: string) => void;
}

export function McpCenterPanel({
  mcp,
  savingMcp,
  loggedIn,
  loggingIn,
  initialDrawerTab,
  onConsumeInitialTab,
  onGoHome,
  onToggleCoreTool,
  onToggleWebPage,
  onSaveEdgeOneConfig,
  onSelectConsultModel,
  onRequestLogin,
  onEdgeOneChanged,
  onNotify,
}: McpCenterPanelProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<McpToolKey>("image");

  useEffect(() => {
    if (initialDrawerTab) {
      setDrawerTab(initialDrawerTab);
      setDrawerOpen(true);
      onConsumeInitialTab?.();
    }
  }, [initialDrawerTab, onConsumeInitialTab]);

  const [authGuideOpen, setAuthGuideOpen] = useState(false);

  const [tokenOpen, setTokenOpen] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState(mcp?.edgeoneApiToken ?? "");
  const [projectDraft, setProjectDraft] = useState(mcp?.edgeoneProjectName ?? "");

  // Managed EdgeOne runtime & login state
  const [edgeOneStatus, setEdgeOneStatus] = useState<EdgeOneStatus | null>(null);
  const [loadingEdgeOne, setLoadingEdgeOne] = useState(false);
  const [edgeOneSite, setEdgeOneSite] = useState<"china" | "global">("china");
  const [loggingInEdgeOne, setLoggingInEdgeOne] = useState(false);
  const [installingRuntime, setInstallingRuntime] = useState(false);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [loggingOutEdgeOne, setLoggingOutEdgeOne] = useState(false);
  const [edgeOneProgress, setEdgeOneProgress] = useState<EdgeOneProgressEvent | null>(null);
  const [edgeOneActionError, setEdgeOneActionError] = useState<string | null>(null);
  const [copiedLoginUrl, setCopiedLoginUrl] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const autoHydratedRef = useRef(false);

  useEffect(() => {
    setTokenDraft(mcp?.edgeoneApiToken ?? "");
    setProjectDraft(mcp?.edgeoneProjectName ?? "");
  }, [mcp?.edgeoneApiToken, mcp?.edgeoneProjectName]);

  const refreshEdgeOne = useCallback(async (refreshAccount = true) => {
    setLoadingEdgeOne(true);
    try {
      const status = await api.getEdgeOneStatus(refreshAccount);
      setEdgeOneStatus(status);
      if (status.authenticated) {
        setEdgeOneActionError(null);
      }
      // If local credentials already exist on disk (e.g. upgraded user) but the managed CLI
      // hasn't been installed yet, auto-prepare it once so they are immediately ready without re-login.
      if (!status.ready && status.hasLocalCredentials && !autoHydratedRef.current) {
        autoHydratedRef.current = true;
        setInstallingRuntime(true);
        setEdgeOneProgress({
          stage: "cli",
          percent: 15,
          message: "检测到已有腾讯云 EdgeOne 凭据，正在自动准备内置部署组件...",
        });
        try {
          const readyStatus = await api.installEdgeOneRuntime(false);
          setEdgeOneStatus(readyStatus);
          setEdgeOneProgress(null);
          if (readyStatus.authenticated) {
            setEdgeOneActionError(null);
          }
        } catch (err) {
          setEdgeOneProgress(null);
          setEdgeOneActionError(String(err));
        } finally {
          setInstallingRuntime(false);
        }
      }
    } catch {
      // Gracefully ignore when backend command is unavailable in standalone frontend builds
    } finally {
      setLoadingEdgeOne(false);
    }
  }, []);

  useEffect(() => {
    void refreshEdgeOne(true);
  }, [refreshEdgeOne]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<EdgeOneProgressEvent>("edgeone-progress", (event) => {
      if (disposed) return;
      setEdgeOneProgress(event.payload);
    })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // Ignore outside Tauri runtime
      });
    return () => {
      disposed = true;
      unlisten?.();
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      if (activeTag === "input" || activeTag === "textarea" || activeTag === "select") return;
      if (authGuideOpen) {
        setAuthGuideOpen(false);
      } else if (drawerOpen) {
        setDrawerOpen(false);
      } else {
        onGoHome();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, authGuideOpen, onGoHome]);

  const webPageEnabled = Boolean(mcp?.webPage);
  const enabledCount = mcp
    ? [mcp.image, mcp.video, mcp.audio, mcp.search, mcp.consult, Boolean(mcp.webPage)].filter(
        Boolean,
      ).length
    : 0;

  const edgeOneDirty =
    tokenDraft.trim() !== (mcp?.edgeoneApiToken ?? "").trim() ||
    projectDraft.trim() !== (mcp?.edgeoneProjectName ?? "").trim();

  const openTheaterDrawer = (tab: McpToolKey) => {
    setDrawerTab(tab);
    setDrawerOpen(true);
  };

  const handleToggleWebPageSwitch = async (next: boolean) => {
    await onToggleWebPage(next);
    if (next) {
      void refreshEdgeOne(true);
    }
  };

  const handleLoginEdgeOne = async () => {
    if (loggingInEdgeOne || installingRuntime) return;
    setLoggingInEdgeOne(true);
    setEdgeOneActionError(null);
    setEdgeOneProgress({
      stage: "prepare",
      percent: 8,
      message: "正在检查部署组件并准备浏览器授权...",
    });
    try {
      const status = await api.loginEdgeOne(edgeOneSite);
      setEdgeOneStatus(status);
      setEdgeOneProgress(null);
      onEdgeOneChanged?.();
      onNotify?.("腾讯云 EdgeOne 登录成功，网站上线能力已自动就绪");
    } catch (err) {
      const msg = String(err);
      setEdgeOneProgress(null);
      if (msg.includes("已取消")) {
        onNotify?.("已取消腾讯云 EdgeOne 登录");
      } else {
        setEdgeOneActionError(msg);
      }
      void refreshEdgeOne(false);
    } finally {
      setLoggingInEdgeOne(false);
    }
  };

  const handleCancelEdgeOneLogin = async () => {
    try {
      await api.cancelEdgeOneLogin();
    } catch {
      // Ignore
    }
  };

  const handleUpgradeEdgeOneRuntime = async () => {
    if (installingRuntime || loggingInEdgeOne) return;
    setInstallingRuntime(true);
    setEdgeOneActionError(null);
    setEdgeOneProgress({
      stage: "cli",
      percent: 25,
      message: "正在检查并更新内置 EdgeOne 部署组件...",
    });
    try {
      const status = await api.installEdgeOneRuntime(true);
      setEdgeOneStatus(status);
      setEdgeOneProgress(null);
      onNotify?.(
        status.cliVersion
          ? `EdgeOne 部署组件已更新至 v${status.cliVersion}`
          : "EdgeOne 部署组件已就绪",
      );
    } catch (err) {
      setEdgeOneProgress(null);
      setEdgeOneActionError(String(err));
    } finally {
      setInstallingRuntime(false);
    }
  };

  const handleSwitchWorkspace = async (workspaceId: string) => {
    if (!workspaceId || switchingWorkspace) return;
    setSwitchingWorkspace(true);
    setEdgeOneActionError(null);
    try {
      const status = await api.switchEdgeOneWorkspace(workspaceId);
      setEdgeOneStatus(status);
      onNotify?.(`已切换工作空间：${status.workspaceName ?? workspaceId}`);
    } catch (err) {
      setEdgeOneActionError(String(err));
    } finally {
      setSwitchingWorkspace(false);
    }
  };

  const handleLogoutEdgeOne = async () => {
    if (loggingOutEdgeOne) return;
    setLoggingOutEdgeOne(true);
    setEdgeOneActionError(null);
    try {
      const status = await api.logoutEdgeOne();
      setEdgeOneStatus(status);
      onNotify?.("已退出腾讯云 EdgeOne 登录");
    } catch (err) {
      setEdgeOneActionError(String(err));
    } finally {
      setLoggingOutEdgeOne(false);
    }
  };

  const handleSaveAdvancedConfig = async () => {
    await onSaveEdgeOneConfig(tokenDraft.trim(), projectDraft.trim());
    void refreshEdgeOne(true);
  };

  const handleCopyLoginUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLoginUrl(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopiedLoginUrl(false), 1800);
    } catch {
      // Fallback: ignore if clipboard is unavailable
    }
  };

  const edgeOneBusy = loggingInEdgeOne || installingRuntime;
  const edgeOneAuthed = Boolean(edgeOneStatus?.authenticated);
  const availableWorkspaces = (edgeOneStatus?.workspaces ?? []).filter((w) => w.available);
  const displayError = edgeOneActionError || (!edgeOneAuthed ? edgeOneStatus?.error ?? null : null);

  const webPageStatusPill = (() => {
    if (edgeOneBusy) {
      return <StatusPill tone="warn">准备中...</StatusPill>;
    }
    if (edgeOneAuthed && webPageEnabled) {
      return <StatusPill tone="ok">已就绪</StatusPill>;
    }
    if (edgeOneAuthed && !webPageEnabled) {
      return <StatusPill tone="neutral">已登录 · 未开启</StatusPill>;
    }
    return <StatusPill tone="warn">待登录</StatusPill>;
  })();

  return (
    <div className="tako-page-sub flex flex-col">
      {/* Page Intro */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-[var(--accent)] mb-1">
            Tako 超级 MCP · 按需启用
          </div>
          <h1 className="text-[20px] font-semibold tracking-[-0.025em] text-[var(--text-primary)] leading-tight">
            MCP 能力中心
          </h1>
          <p className="text-[12.5px] text-[var(--text-secondary)] mt-1">
            开启的能力自动同步至 Tako 模式客户端；点击卡片即可在右侧抽屉体验演示。
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[12px] text-[var(--text-muted)] tabular-nums">
            <strong className="text-[var(--text-primary)] font-semibold">{enabledCount}</strong> / 6 已开启
          </span>
          <button
            type="button"
            data-testid="open-mcp-demo"
            onClick={() => openTheaterDrawer(drawerTab)}
            className="h-[32px] px-3 rounded-[9px] border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] text-[12px] font-medium text-[var(--text-primary)] inline-flex items-center gap-1.5 transition cursor-pointer"
          >
            <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
            <span>效果演示</span>
          </button>
        </div>
      </div>

      {/* Capabilities Grid: Full-width Tako Web Page + 2-Column 5 Core Abilities */}
      <div className="grid grid-cols-1 min-[640px]:grid-cols-2 tako-list-stack">
        {/* Featured Full-Width Card: Tako Web Page (Tencent Cloud EdgeOne) */}
        <article
          data-mcp-tool="tako_deploy_website"
          className="min-[640px]:col-span-2 tako-card-surface border border-[var(--accent-border)] tako-panel-pad flex flex-col gap-3"
          style={{ background: "var(--webpage-grad)" }}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5">
                <span className="h-8 w-8 rounded-[9px] bg-[var(--accent)] text-white inline-flex items-center justify-center shrink-0">
                  <Globe2 className="h-4 w-4" strokeWidth={1.8} />
                </span>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                    网站上线 · Tako Web Page
                  </h3>
                  <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[var(--accent)]">
                    腾讯云 EdgeOne · 内置稳定版
                  </span>
                  {webPageStatusPill}
                </div>
              </div>

              <p className="text-[12px] text-[var(--text-secondary)] mt-2.5 leading-relaxed">
                只需点击下方登录一次腾讯云，运行环境、部署组件、项目命名与公网发布全部由 Tako 自动托管，对话一句话即可上线网站。
              </p>
            </div>

            <div className="flex items-center gap-2.5 shrink-0 pt-0.5">
              <button
                type="button"
                onClick={() => setAuthGuideOpen(true)}
                className="h-[32px] px-3 rounded-[9px] border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] text-[12px] font-medium text-[var(--text-primary)] transition cursor-pointer"
              >
                使用说明
              </button>
              <ToggleSwitch
                checked={webPageEnabled}
                disabled={savingMcp || !mcp}
                ariaLabel="开启网站上线 · Tako Web Page"
                data-testid="mcp-toggle-webpage"
                onChange={(next) => void handleToggleWebPageSwitch(next)}
              />
            </div>
          </div>

          {/* Live Progress Panel (Runtime download / CLI install / Browser OAuth) */}
          {edgeOneBusy && edgeOneProgress && (
            <div className="rounded-[10px] border border-[var(--accent-border)] bg-[var(--bg-card)]/90 px-3.5 py-3 flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <div className="flex items-center gap-2 min-w-0 text-[var(--text-primary)] font-medium">
                  <Loader2 className="h-3.5 w-3.5 text-[var(--accent)] animate-spin shrink-0" />
                  <span className="truncate">{edgeOneProgress.message}</span>
                </div>
                <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0 tabular-nums">
                  {edgeOneProgress.percent}%
                </span>
              </div>

              <div className="h-1.5 w-full rounded-full bg-[var(--bg-subtle)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
                  style={{ width: `${Math.max(5, Math.min(100, edgeOneProgress.percent))}%` }}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  {edgeOneProgress.loginUrl && (
                    <>
                      <button
                        type="button"
                        onClick={() => void api.openUrl(edgeOneProgress.loginUrl!)}
                        className="h-7 px-2.5 rounded-[7px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[11.5px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                      >
                        <span>打开浏览器授权页</span>
                        <ExternalLink className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCopyLoginUrl(edgeOneProgress.loginUrl!)}
                        className="h-7 px-2.5 rounded-[7px] border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] text-[var(--text-secondary)] text-[11.5px] font-medium inline-flex items-center gap-1 cursor-pointer"
                      >
                        {copiedLoginUrl ? (
                          <>
                            <Check className="h-3 w-3 text-[var(--success)]" />
                            <span>已复制</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" />
                            <span>复制链接</span>
                          </>
                        )}
                      </button>
                    </>
                  )}
                </div>

                {loggingInEdgeOne && (
                  <button
                    type="button"
                    onClick={() => void handleCancelEdgeOneLogin()}
                    className="h-7 px-2.5 rounded-[7px] border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] text-[11.5px] font-medium cursor-pointer"
                  >
                    取消登录
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Authenticated Account & Workspace Bar */}
          {!edgeOneBusy && edgeOneAuthed && edgeOneStatus && (
            <div className="rounded-[10px] border border-[var(--success-border)] bg-[var(--bg-card)]/85 px-3.5 py-2.5 flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0 text-[12px]">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--success)]">
                    <UserCheck className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      {edgeOneStatus.accountName ||
                        edgeOneStatus.accountId ||
                        (edgeOneStatus.authMode === "api_token" ? "API Token 已认证" : "腾讯云已登录")}
                    </span>
                  </span>

                  {availableWorkspaces.length > 1 ? (
                    <label className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
                      <Layers className="h-3.5 w-3.5 text-[var(--text-muted)] shrink-0" />
                      <span>工作空间</span>
                      <select
                        value={edgeOneStatus.workspaceId ?? ""}
                        disabled={switchingWorkspace}
                        onChange={(e) => void handleSwitchWorkspace(e.target.value)}
                        className="h-6 pl-2 pr-6 rounded-[6px] border border-[var(--border)] bg-[var(--bg-subtle)] text-[11.5px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] cursor-pointer disabled:opacity-50"
                      >
                        {availableWorkspaces.map((ws) => (
                          <option key={ws.id} value={ws.id}>
                            {ws.name}
                            {ws.plan ? ` (${ws.plan})` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    edgeOneStatus.workspaceName && (
                      <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--text-secondary)]">
                        <Layers className="h-3.5 w-3.5 text-[var(--text-muted)] shrink-0" />
                        <span>{edgeOneStatus.workspaceName}</span>
                        {edgeOneStatus.plan && (
                          <span className="px-1.5 py-0.2 rounded bg-[var(--bg-subtle)] text-[10.5px] text-[var(--text-muted)] font-medium">
                            {edgeOneStatus.plan}
                          </span>
                        )}
                      </span>
                    )
                  )}

                  {edgeOneStatus.authMode === "api_token" && (
                    <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] font-medium">
                      API Token 模式
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    disabled={loadingEdgeOne || switchingWorkspace}
                    onClick={() => void refreshEdgeOne(true)}
                    className="h-7 px-2 rounded-[7px] border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] text-[11.5px] text-[var(--text-secondary)] inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${loadingEdgeOne ? "animate-spin" : ""}`}
                    />
                    <span>刷新</span>
                  </button>
                  {edgeOneStatus.authMode === "login" && (
                    <button
                      type="button"
                      disabled={loggingOutEdgeOne}
                      onClick={() => void handleLogoutEdgeOne()}
                      className="h-7 px-2 rounded-[7px] border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      <LogOut className="h-3 w-3" />
                      <span>{loggingOutEdgeOne ? "退出中..." : "退出"}</span>
                    </button>
                  )}
                </div>
              </div>

              {!webPageEnabled && (
                <div className="pt-1.5 border-t border-[var(--border)]/60 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[var(--warning)]">
                  <span>腾讯云账号已登录，开启右上角开关后 AI 即可直接发布网站。</span>
                  <button
                    type="button"
                    disabled={savingMcp || !mcp}
                    onClick={() => void handleToggleWebPageSwitch(true)}
                    className="h-6 px-2.5 rounded-[6px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[11px] font-semibold cursor-pointer disabled:opacity-50"
                  >
                    立即开启
                  </button>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3 w-3 text-[var(--success)] shrink-0" />
                  <span>
                    部署组件 EdgeOne CLI v{edgeOneStatus.cliVersion ?? "已就绪"}
                    {edgeOneStatus.nodeVersion
                      ? ` · Node ${edgeOneStatus.nodeVersion}${edgeOneStatus.nodeManaged ? " (内置)" : ""}`
                      : ""}
                    {" · 已内置于 Tako MCP"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void handleUpgradeEdgeOneRuntime()}
                  className="text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)] hover:underline cursor-pointer"
                >
                  更新部署组件
                </button>
              </div>
            </div>
          )}

          {/* Unauthenticated One-Click Login CTA */}
          {!edgeOneBusy && !edgeOneAuthed && (
            <div className="rounded-[10px] border border-[var(--border)] bg-[var(--bg-card)]/85 px-3.5 py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1 min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                  {loadingEdgeOne ? "正在检测腾讯云 EdgeOne 登录状态..." : "登录后即可一句话上线网站"}
                </div>
                <div className="text-[11.5px] text-[var(--text-muted)] leading-snug">
                  {edgeOneStatus?.cliInstalled
                    ? `内置部署组件 v${edgeOneStatus.cliVersion} 已就绪，点击右侧按钮在浏览器确认一次即可。`
                    : "首次登录会自动从国内镜像准备好部署组件（无需手动装 Node.js 或命令行），随后打开浏览器确认一次即可。"}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <div
                  className="h-[32px] p-0.5 rounded-[8px] border border-[var(--border)] bg-[var(--bg-subtle)] inline-flex items-center text-[11px]"
                  role="group"
                  aria-label="选择腾讯云站点"
                >
                  <button
                    type="button"
                    onClick={() => setEdgeOneSite("china")}
                    className={`h-full px-2 rounded-[6px] font-medium transition cursor-pointer ${
                      edgeOneSite === "china"
                        ? "bg-[var(--bg-card)] text-[var(--text-primary)] shadow-xs"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    中国站
                  </button>
                  <button
                    type="button"
                    onClick={() => setEdgeOneSite("global")}
                    className={`h-full px-2 rounded-[6px] font-medium transition cursor-pointer ${
                      edgeOneSite === "global"
                        ? "bg-[var(--bg-card)] text-[var(--text-primary)] shadow-xs"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    国际站
                  </button>
                </div>

                <button
                  type="button"
                  data-testid="edgeone-login-btn"
                  disabled={loadingEdgeOne}
                  onClick={() => void handleLoginEdgeOne()}
                  className="h-[32px] px-3.5 rounded-[9px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-semibold inline-flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  <span>一键登录腾讯云 EdgeOne</span>
                </button>
              </div>
            </div>
          )}

          {/* Error Banner (if any) */}
          {displayError && !edgeOneBusy && (
            <div className="rounded-[10px] border border-[var(--warning-border)] bg-[var(--warning-soft)] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[var(--warning)]">
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span className="leading-snug break-words">{displayError}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEdgeOneActionError(null);
                  void refreshEdgeOne(true);
                }}
                className="h-7 px-2.5 rounded-[7px] bg-[var(--bg-card)] border border-[var(--warning-border)] text-[var(--warning)] text-[11.5px] font-semibold inline-flex items-center gap-1 cursor-pointer shrink-0"
              >
                <RefreshCw className="h-3 w-3" />
                <span>重试检测</span>
              </button>
            </div>
          )}

          {/* Collapsible Advanced: Optional Token & Project Name */}
          <div className="pt-2 border-t border-[var(--accent-border)]/70">
            <button
              type="button"
              onClick={() => setTokenOpen((prev) => !prev)}
              className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[var(--accent)] hover:underline cursor-pointer"
            >
              <span>高级：自定义默认项目名 / API Token（选填）</span>
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${tokenOpen ? "rotate-180" : ""}`}
              />
            </button>

            {tokenOpen && (
              <div className="mt-3 flex flex-col gap-2.5">
                <p className="text-[11px] text-[var(--text-muted)]">
                  普通用户留空即可，使用上方一键浏览器登录最省心；仅在团队固定账号或需要固定发布项目名时选填。
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-medium text-[var(--text-secondary)]">
                      EDGEONE_PAGES_API_TOKEN
                    </label>
                    <div className="relative">
                      <input
                        type={showToken ? "text" : "password"}
                        value={tokenDraft}
                        onChange={(e) => setTokenDraft(e.target.value)}
                        placeholder="留空即可，使用上方一键浏览器登录"
                        className="w-full h-[33px] pl-2.5 pr-8 rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] text-[12px] font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken((v) => !v)}
                        aria-label={showToken ? "隐藏 Token" : "显示 Token"}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                      >
                        {showToken ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-medium text-[var(--text-secondary)]">
                      默认项目名（EDGEONE_PAGES_PROJECT_NAME）
                    </label>
                    <input
                      type="text"
                      value={projectDraft}
                      onChange={(e) => setProjectDraft(e.target.value)}
                      placeholder="例如：portfolio-site（留空自动智能命名）"
                      className="w-full h-[33px] px-2.5 rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={!edgeOneDirty || savingMcp}
                    onClick={() => void handleSaveAdvancedConfig()}
                    className="h-7 px-3 rounded-[8px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[11.5px] font-semibold cursor-pointer disabled:opacity-45"
                  >
                    {savingMcp ? "保存中..." : "保存配置"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </article>

        {/* 5 Clean Core Capability Cards */}
        {CORE_MCP_CARDS.map(({ key, mcpToolAttr, title, description, Icon }) => {
          const enabled = Boolean(mcp?.[key]);
          return (
            <article
              key={key}
              data-mcp-tool={mcpToolAttr}
              className="tako-card-surface border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--border-strong)] tako-panel-pad min-h-[126px] flex flex-col transition"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="h-8 w-8 rounded-[9px] bg-[var(--bg-subtle)] text-[var(--text-secondary)] inline-flex items-center justify-center shrink-0">
                  <Icon className="h-[17px] w-[17px]" strokeWidth={1.7} />
                </span>
                <ToggleSwitch
                  checked={enabled}
                  disabled={savingMcp || !mcp}
                  ariaLabel={`切换${title}开关`}
                  data-testid={`toggle-mcp-${key}`}
                  onChange={() => onToggleCoreTool(key)}
                />
              </div>

              <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)] mt-3">
                {title}
              </h3>
              <p className="text-[11.5px] text-[var(--text-muted)] mt-1 leading-relaxed">
                {description}
              </p>

              <div className="mt-auto pt-3 flex items-center justify-between gap-2">
                <StatusPill tone={enabled ? "ok" : "neutral"}>
                  {enabled ? "已开启" : "已关闭"}
                </StatusPill>
                <button
                  type="button"
                  data-testid={`open-mcp-demo-${key}`}
                  onClick={() => openTheaterDrawer(key)}
                  className="text-[11.5px] font-semibold text-[var(--accent)] hover:underline cursor-pointer"
                >
                  体验能力 →
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {/* EdgeOne Usage Guide Modal */}
      {authGuideOpen && (
        <div
          className="fixed inset-0 z-50 modal-backdrop flex items-center justify-center p-4"
          onClick={() => setAuthGuideOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[440px] rounded-[15px] border border-[var(--border)] bg-[var(--bg-card)] shadow-[var(--shadow-modal)] overflow-hidden"
          >
            <div className="px-5 py-3.5 border-b border-[var(--border)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe2 className="h-4 w-4 text-[var(--accent)]" />
                <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
                  网站上线 · 两步即可发布公网
                </h2>
              </div>
              <button
                type="button"
                aria-label="关闭使用说明"
                onClick={() => setAuthGuideOpen(false)}
                className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-5 py-4 flex flex-col gap-3 text-[12.5px] text-[var(--text-secondary)]">
              <div className="rounded-[10px] bg-[var(--bg-subtle)]/80 px-3.5 py-2.5 text-[12px] text-[var(--text-primary)]">
                无需手动安装 Node.js、命令行工具或申请 API Token，Tako 已把整套部署能力封装进内置 MCP：
              </div>
              <ol className="space-y-2.5 pl-4 list-decimal leading-relaxed">
                <li>
                  <strong className="text-[var(--text-primary)]">一键登录腾讯云</strong>：点击卡片里的「一键登录腾讯云 EdgeOne」，Tako 自动准备好本地组件并拉起浏览器，确认一次授权后会自动开启并同步至所有 Tako 客户端。
                </li>
                <li>
                  <strong className="text-[var(--text-primary)]">对话一句直接上线</strong>：在 Codex、Claude、Antigravity 或 WorkBuddy 中写完网页后，直接告诉 AI「帮我把这个网站部署上线」，支持整个文件夹、单个 HTML 文件或 ZIP 包，几秒内返回可公开访问的 HTTPS 地址。
                </li>
              </ol>
              <p className="text-[11px] text-[var(--text-muted)]">
                提示：所有发布均通过本地托管组件直连腾讯云 EdgeOne，告别 npx 超时卡死；如需多空间切换或固定项目名，可直接在卡片内操作。
              </p>
            </div>

            <div className="px-5 py-3 border-t border-[var(--border)] flex items-center justify-end gap-2">
              {!edgeOneAuthed && (
                <button
                  type="button"
                  disabled={edgeOneBusy}
                  onClick={() => {
                    setAuthGuideOpen(false);
                    void handleLoginEdgeOne();
                  }}
                  className="h-8 px-3.5 rounded-[8px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-semibold cursor-pointer disabled:opacity-50"
                >
                  立即一键登录
                </button>
              )}
              <button
                type="button"
                onClick={() => setAuthGuideOpen(false)}
                className="h-8 px-3 rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-subtle)] text-[12px] font-medium text-[var(--text-secondary)] cursor-pointer"
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Right Slide-Over Drawer for McpInlineTheater */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 modal-backdrop flex justify-end"
          onClick={() => setDrawerOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="drawer-enter w-[min(680px,94vw)] h-full bg-[var(--bg-canvas)] border-l border-[var(--border)] shadow-[var(--shadow-modal)] flex flex-col overflow-hidden"
          >
            <div className="h-[48px] shrink-0 px-4 border-b border-[var(--border)] bg-[var(--bg-card)] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Sparkles className="h-4 w-4 text-[var(--accent)] shrink-0" />
                <span className="text-[13.5px] font-semibold text-[var(--text-primary)] truncate">
                  MCP 能力体验剧场
                </span>
              </div>
              <button
                type="button"
                aria-label="关闭能力体验抽屉"
                onClick={() => setDrawerOpen(false)}
                className="h-7 w-7 rounded-[7px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] inline-flex items-center justify-center cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto subtle-scroll p-4">
              <McpInlineTheater
                open={drawerOpen}
                activeTab={drawerTab}
                mcp={mcp}
                savingMcp={savingMcp}
                loggedIn={loggedIn}
                loggingIn={loggingIn}
                onSelectTab={(tab) => setDrawerTab(tab)}
                onToggleMcp={(key) => onToggleCoreTool(key)}
                onSelectConsultModel={onSelectConsultModel}
                onRequestLogin={onRequestLogin}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
