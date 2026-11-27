import { useEffect, useState } from "react";
import {
  ArrowRight,
  Brain,
  Film,
  Globe,
  Globe2,
  Headphones,
  Image as ImageIcon,
  Sparkles,
  X,
} from "lucide-react";
import type {
  EdgeOneSiteRecord,
  EdgeOneStatus,
  McpToolsConfig,
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
  edgeOneStatus: EdgeOneStatus | null;
  edgeOneSites: EdgeOneSiteRecord[];
  initialDrawerTab?: McpToolKey | null;
  onConsumeInitialTab?: () => void;
  onGoHome: () => void;
  onOpenWebPage: () => void;
  onToggleCoreTool: (key: McpToolKey) => void;
  onToggleWebPage: (next: boolean) => Promise<void>;
  onSelectConsultModel: (model: string) => void;
  onRequestLogin: () => void;
  onNotify?: (msg: string) => void;
}

export function McpCenterPanel({
  mcp,
  savingMcp,
  loggedIn,
  loggingIn,
  edgeOneStatus,
  edgeOneSites,
  initialDrawerTab,
  onConsumeInitialTab,
  onGoHome: _onGoHome,
  onOpenWebPage,
  onToggleCoreTool,
  onToggleWebPage,
  onSelectConsultModel,
  onRequestLogin,
  onNotify: _onNotify,
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

  const webPageEnabled = Boolean(mcp?.webPage);
  const edgeOneAuthed = Boolean(edgeOneStatus?.authenticated);
  const coreEnabledCount = CORE_MCP_CARDS.filter((c) => Boolean(mcp?.[c.key])).length;

  const openTheaterDrawer = (tab: McpToolKey) => {
    setDrawerTab(tab);
    setDrawerOpen(true);
  };

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
            <strong className="text-[var(--text-primary)] font-semibold">
              {coreEnabledCount}
            </strong>{" "}
            / {CORE_MCP_CARDS.length} 已开启
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

      {/* Lightweight Website Hosting Bridge Bar (full management moved to standalone Tako Web Page) */}
      <article
        data-mcp-tool="tako_deploy_website"
        data-testid="mcp-webpage-bridge"
        className="tako-card-surface border border-[var(--accent-border)] px-[var(--density-card-px)] py-[var(--density-card-py)] flex flex-wrap items-center justify-between gap-3"
        style={{ background: "var(--webpage-grad)" }}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="h-8 w-8 rounded-[9px] bg-[var(--accent)] text-white inline-flex items-center justify-center shrink-0">
            <Globe2 className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                网站托管 · Tako Web Page
              </h2>
              {edgeOneAuthed ? (
                <StatusPill tone="ok">
                  已登录{Array.isArray(edgeOneSites) && edgeOneSites.length > 0 ? ` · ${edgeOneSites.length} 个站点` : ""}
                </StatusPill>
              ) : (
                <StatusPill tone="warn">待登录</StatusPill>
              )}
            </div>
            <p className="text-[11.5px] text-[var(--text-secondary)] truncate mt-0.5">
              允许 Claude / Codex / Antigravity / WorkBuddy 通过 MCP 发布网站，已迁至独立页面集中管理。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <ToggleSwitch
            checked={webPageEnabled}
            disabled={savingMcp || !mcp}
            ariaLabel="开启网站上线 · Tako Web Page"
            data-testid="mcp-toggle-webpage"
            onChange={(next) => void onToggleWebPage(next)}
          />
          <button
            type="button"
            data-testid="mcp-goto-webpage"
            onClick={onOpenWebPage}
            className="h-[30px] px-3 rounded-[8px] border border-[var(--accent-border)] bg-[var(--bg-card)] hover:bg-[var(--accent-soft)] text-[12px] font-semibold text-[var(--accent)] inline-flex items-center gap-1 transition cursor-pointer"
          >
            <span>{edgeOneAuthed ? "管理网站" : "前往登录"}</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </article>

      {/* 5 Clean Core Capability Cards (3-col at >=760px, 2-col at 640-759px) */}
      <div className="grid grid-cols-1 min-[640px]:grid-cols-2 min-[760px]:grid-cols-3 tako-list-stack">
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
