import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.PLAYWRIGHT_MODULE) {
  throw new Error("Set PLAYWRIGHT_MODULE to an installed playwright/index.mjs path.");
}
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);

const URL = process.env.TAKO_TEST_URL ?? "http://127.0.0.1:1420/";
const SCREENSHOT_DIR = process.env.WEBPAGE_UI_SHOTS ?? "/tmp/tako-webpage-ui-shots";
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function installMock(init) {
  const { theme, density } = init;
  localStorage.setItem("tako-switch-theme", theme);
  localStorage.setItem("tako-switch-density", density);

  const listeners = new Map();
  let listenerSeq = 1;
  const emitEvent = (event, payload) => {
    for (const fn of listeners.get(event) ?? []) {
      fn({ event, id: 1, payload });
    }
  };

  let edgeOneStatus = {
    nodeAvailable: true,
    nodeVersion: "v22.14.0",
    nodeManaged: true,
    cliInstalled: true,
    cliVersion: "1.7.7",
    cliPath: "~/.tako/switch/edgeone/cli/node_modules/edgeone/edgeone-bin/edgeone.js",
    ready: true,
    hasLocalCredentials: true,
    authenticated: true,
    authMode: "login",
    accountName: "tako-dev@edgeone.cn",
    accountId: "1196768261",
    workspaceId: "zone-personal",
    workspaceName: "个人空间",
    plan: "Pro",
    workspaceStatus: "Active",
    workspaces: [
      { id: "zone-personal", name: "个人空间", plan: "Pro", status: "Active", available: true, current: true, cached: true },
      { id: "zone-team", name: "Tako 团队空间", plan: "Enterprise", status: "Active", available: true, current: false, cached: true },
    ],
    error: null,
    cached: true,
    checkedAt: Date.now() - 8000,
  };

  const now = Date.now();
  let sites = [
    {
      id: "pages-portfolio",
      projectName: "portfolio",
      projectId: "pages-portfolio",
      url: "https://portfolio.edgeone.app",
      consoleUrl: "https://console.cloud.tencent.com/edgeone/pages/project/pages-portfolio",
      environment: "production",
      area: "global",
      source: "mcp",
      workspaceId: "zone-personal",
      workspaceName: "个人空间",
      localSourcePath: "/Users/dev/Sites/portfolio",
      localSourceExists: true,
      pinned: true,
      note: "个人主页 V2",
      deployedAt: now - 180_000,
      deployCount: 3,
      history: [
        { id: "dep-3", url: "https://portfolio.edgeone.app", deploymentId: "dep-3", environment: "production", area: "global", source: "mcp", deployedAt: now - 180_000, durationMs: 2400 },
        { id: "dep-2", url: "https://preview-2.portfolio.edgeone.app", deploymentId: "dep-2", environment: "preview", area: "global", source: "ui", deployedAt: now - 86_400_000, durationMs: 2900 },
      ],
    },
    {
      id: "pages-campaign",
      projectName: "campaign-preview",
      projectId: "pages-campaign",
      url: "https://campaign-preview.edgeone.app",
      consoleUrl: "https://console.cloud.tencent.com/edgeone/pages/project/pages-campaign",
      environment: "preview",
      area: "overseas",
      source: "ui",
      workspaceId: "zone-personal",
      workspaceName: "个人空间",
      localSourcePath: "/Users/dev/Sites/campaign",
      localSourceExists: true,
      pinned: false,
      note: null,
      deployedAt: now - 7_200_000,
      deployCount: 1,
      history: [
        { id: "dep-c1", url: "https://campaign-preview.edgeone.app", deploymentId: "dep-c1", environment: "preview", area: "overseas", source: "ui", deployedAt: now - 7_200_000, durationMs: 3100 },
      ],
    },
  ];

  const envStore = {
    production: [{ key: "API_BASE_URL", value: "https://api.example.com", environment: "production" }],
    preview: [{ key: "DEBUG_MODE", value: "true", environment: "preview" }],
  };

  let mcpState = {
    image: true,
    video: true,
    audio: true,
    search: true,
    consult: false,
    webPage: true,
    edgeoneApiToken: null,
    edgeoneProjectName: null,
    outputDir: "~/TakoOutputs",
    consultModel: "gpt-5.4",
  };

  const dashboard = {
    account: {
      loggedIn: true,
      baseUrl: "https://api.tako.example",
      maskedKey: "sk-tako...9999",
      userName: "TakoDev",
      keyName: "Pro Key",
      activeKeyId: "k1",
      displayLabel: "TakoDev - Pro Key",
      savedKeys: [],
      planName: "Pro",
      walletRemain: 50,
      walletUsed: 12,
      walletRemainUsd: 50,
      walletUsedUsd: 12,
      quota: null,
      error: null,
    },
    state: {
      baseUrl: "https://api.tako.example",
      manifestUrl: "",
      fallbackManifestUrl: "",
      autoCheckUpdates: false,
      preferChineseUi: true,
      uiDensity: density,
      themePref: theme,
      mcp: mcpState,
      hiddenApps: [],
    },
    apps: [
      { id: "claude", name: "Claude Desktop", mode: "tako", mcpEnabled: true, hasBackup: true, running: true, install: { installed: true, version: "2.1.78", installPath: "/Applications/Claude.app", installKind: "app" }, diagnostic: { ok: true, issues: [], notes: [] }, chineseConfigured: true, uiPatch: { status: "patched", patchVersion: "1", hasValidBackup: true, targetAsarPath: null, note: null } },
      { id: "codex", name: "Codex", mode: "tako", mcpEnabled: true, hasBackup: true, running: false, install: { installed: true, version: "0.114.0", installPath: "/Applications/Codex.app", installKind: "app" }, diagnostic: { ok: true, issues: [], notes: [] }, chineseConfigured: true, uiPatch: { status: "not_applicable", patchVersion: null, hasValidBackup: false, targetAsarPath: null, note: null } },
      { id: "antigravity", name: "Antigravity", mode: "official", mcpEnabled: false, hasBackup: false, running: false, install: { installed: true, version: "1.18.4", installPath: "/Applications/Antigravity.app", installKind: "app" }, diagnostic: { ok: true, issues: [], notes: [] }, chineseConfigured: true, uiPatch: { status: "patched", patchVersion: "1", hasValidBackup: true, targetAsarPath: null, note: null } },
      { id: "workbuddy", name: "WorkBuddy", mode: "official", mcpEnabled: false, hasBackup: false, running: false, install: { installed: false, version: null, installPath: null, installKind: null }, diagnostic: { ok: true, issues: [], notes: [] }, chineseConfigured: false, uiPatch: { status: "not_applicable", patchVersion: null, hasValidBackup: false, targetAsarPath: null, note: null } },
      { id: "dsh-tako", name: "DSH Tako", mode: "tako", mcpEnabled: true, hasBackup: false, running: true, install: { installed: true, version: "1.5.2", installPath: "/Applications/DSH.app", installKind: "app" }, diagnostic: { ok: true, issues: [], notes: [] }, chineseConfigured: false, uiPatch: { status: "not_applicable", patchVersion: null, hasValidBackup: false, targetAsarPath: null, note: null } },
    ],
    cachedManifest: null,
    localGatewayHealthy: true,
    localGatewayUrl: "http://127.0.0.1:18419",
    appVersion: "2.3.9",
    os: "macos",
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };

  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      const id = listenerSeq++;
      window[`__cb_${id}`] = cb;
      return id;
    },
    invoke: async (cmd, args = {}) => {
      if (cmd === "plugin:event|listen") {
        const fn = window[`__cb_${args.handler}`];
        if (!listeners.has(args.event)) listeners.set(args.event, []);
        listeners.get(args.event).push(fn);
        return args.handler;
      }
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_dashboard") return { ...dashboard, state: { ...dashboard.state, mcp: { ...mcpState } } };
      if (cmd === "get_running_states") return { claude: true, codex: false, antigravity: false, workbuddy: false, "dsh-tako": true };
      if (cmd === "get_extensions_summary") return { mcpCount: 6, skillsCount: 12, skillsUpdatableCount: 2, pluginsCount: 4, promptsCount: 3 };
      if (cmd === "sync_window_theme" || cmd === "open_url" || cmd === "open_local_path" || cmd === "report_frontend_error") return null;
      if (cmd === "save_settings") {
        if (args.input?.mcp) mcpState = { ...mcpState, ...args.input.mcp };
        dashboard.state = { ...dashboard.state, ...args.input, mcp: { ...mcpState } };
        return dashboard.state;
      }
      if (cmd === "get_edgeone_status") {
        return { ...edgeOneStatus, cached: Boolean(args.cacheOnly) };
      }
      if (cmd === "list_edgeone_sites") return [...sites];
      if (cmd === "create_edgeone_sample_site") {
        return {
          path: "/Users/dev/.tako/switch/edgeone/samples/tako-demo-abc12",
          exists: true,
          kind: "folder",
          name: "tako-demo-abc12",
          fileCount: 1,
          totalBytes: 1842,
          hasIndexHtml: true,
          hasPackageJson: false,
          linkedProjectName: null,
          suggestedProjectName: "tako-demo-abc12",
          valid: true,
          warning: null,
        };
      }
      if (cmd === "deploy_edgeone_website") {
        const req = args.req;
        const proj = req.projectName || "tako-demo-abc12";
        emitEvent("edgeone-deploy-progress", {
          stage: "uploading",
          percent: 62,
          message: "正在上传静态资源至腾讯云 EdgeOne...",
          projectName: proj,
          logLine: "[cli] Uploading assets...",
          elapsedMs: 420,
        });
        await new Promise((r) => setTimeout(r, 80));
        const res = {
          url: `https://${proj}.edgeone.app`,
          projectName: proj,
          projectId: `pages-${proj}`,
          deploymentId: `dep-${Date.now()}`,
          consoleUrl: `https://console.cloud.tencent.com/edgeone/pages/project/pages-${proj}`,
          environment: req.environment || "production",
          area: req.area || "global",
          durationMs: 1250,
        };
        sites = [
          {
            id: res.projectId,
            projectName: res.projectName,
            projectId: res.projectId,
            url: res.url,
            consoleUrl: res.consoleUrl,
            environment: res.environment,
            area: res.area,
            source: "ui",
            workspaceId: edgeOneStatus.workspaceId,
            workspaceName: edgeOneStatus.workspaceName,
            localSourcePath: req.path,
            localSourceExists: true,
            pinned: false,
            note: null,
            deployedAt: Date.now(),
            deployCount: 1,
            history: [{ id: res.deploymentId, url: res.url, deploymentId: res.deploymentId, environment: res.environment, area: res.area, source: "ui", deployedAt: Date.now(), durationMs: 1250 }],
          },
          ...sites.filter((s) => s.projectName !== res.projectName),
        ];
        return res;
      }
      if (cmd === "check_edgeone_sites_health") {
        return (args.urls ?? []).map((url, idx) => ({
          url,
          reachable: true,
          statusCode: 200,
          latencyMs: 64 + idx * 19,
          checkedAt: Date.now(),
          error: null,
        }));
      }
      if (cmd === "update_edgeone_site_meta") {
        const patch = args.patch;
        sites = sites.map((s) =>
          s.id === patch.id
            ? {
                ...s,
                pinned: patch.pinned !== undefined ? patch.pinned : s.pinned,
                note: patch.note !== undefined ? (patch.note.trim() || null) : s.note,
              }
            : s,
        );
        return [...sites];
      }
      if (cmd === "remove_edgeone_site_record") {
        sites = sites.filter((s) => s.id !== args.id);
        return [...sites];
      }
      if (cmd === "edgeone_env_list") return [...(envStore[args.environment || "production"] ?? [])];
      if (cmd === "edgeone_env_set") {
        const e = args.environment || "production";
        envStore[e] = [...(envStore[e] ?? []).filter((v) => v.key !== args.key), { key: args.key, value: args.value, environment: e }];
        return [...envStore[e]];
      }
      if (cmd === "switch_edgeone_workspace") {
        const target = edgeOneStatus.workspaces.find((w) => w.id === args.workspace);
        if (target) {
          edgeOneStatus = { ...edgeOneStatus, workspaceId: target.id, workspaceName: target.name, plan: target.plan };
        }
        return { ...edgeOneStatus };
      }
      return null;
    },
  };
}

const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
  headless: true,
});

try {
  for (const viewport of [
    { width: 820, height: 650 },
    { width: 720, height: 560 },
  ]) {
    for (const theme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport });
      const page = await ctx.newPage();
      await page.addInitScript(installMock, { theme, density: "compact" });
      await page.goto(URL, { waitUntil: "networkidle" });

      // 1. Overview: classic desktop client rows intact + 3 capability cards visible
      await page.getByTestId("overview-webpage-card").waitFor();
      await page.getByTestId("open-mcp-center").waitFor();
      await page.getByTestId("ext-hub-home-section").waitFor();
      await page.getByTestId("overview-action-claude").waitFor();

      const ovOverflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        main: document.querySelector("main")?.scrollWidth ?? 0,
        w: window.innerWidth,
      }));
      assert.ok(ovOverflow.doc <= ovOverflow.w && ovOverflow.main <= ovOverflow.w, `Overview overflow ${JSON.stringify(ovOverflow)}`);

      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `overview-${viewport.width}-${theme}.png`) });

      // 2. Navigate to standalone Tako Web Page
      await page.getByTestId("open-webpage").click();
      await page.getByTestId("webpage-panel").waitFor();
      await page.getByTestId("webpage-site-row-portfolio").waitFor();

      // Batch health probe
      await page.getByTestId("webpage-batch-health-btn").click();
      await page.getByText("200 · 64ms").waitFor();

      // Generate sample site & deploy!
      await page.getByRole("button", { name: "生成演示页" }).click();
      await page.getByTestId("webpage-deploy-submit-btn").waitFor();
      await page.getByTestId("webpage-deploy-submit-btn").click();
      await page.getByTestId("webpage-deploy-success").waitFor();
      await page.getByTestId("webpage-site-row-tako-demo-abc12").waitFor();

      // Search filter
      await page.getByTestId("webpage-sites-search").fill("campaign");
      assert.equal(await page.getByTestId("webpage-site-row-campaign-preview").count(), 1);
      assert.equal(await page.getByTestId("webpage-site-row-portfolio").count(), 0);
      await page.getByTestId("webpage-sites-search").fill("");

      const wpOverflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        main: document.querySelector("main")?.scrollWidth ?? 0,
        w: window.innerWidth,
      }));
      assert.ok(wpOverflow.doc <= wpOverflow.w && wpOverflow.main <= wpOverflow.w, `WebPage overflow ${JSON.stringify(wpOverflow)}`);

      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `webpage-${viewport.width}-${theme}.png`) });

      // 3. Back home -> MCP Center bridge check -> jump back to WebPage
      await page.getByTestId("topbar-back-home").click();
      await page.getByTestId("open-mcp-center").click();
      await page.getByTestId("mcp-webpage-bridge").waitFor();
      await page.getByTestId("mcp-toggle-webpage").waitFor();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `mcp-${viewport.width}-${theme}.png`) });

      await page.getByTestId("mcp-goto-webpage").click();
      await page.getByTestId("webpage-panel").waitFor();

      console.log(`PASS WebPage+Overview+MCP ${viewport.width}x${viewport.height}-${theme}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
