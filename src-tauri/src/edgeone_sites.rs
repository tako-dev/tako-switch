use crate::config::{apply_proxy_policy, read_switch_state, AppPaths};
use crate::edgeone::{
    edgeone_root_dir, ensure_edgeone_cli, expand_user_path, extract_last_json_object,
    friendly_edgeone_error, read_linked_project_name, resolve_project_name, run_edgeone_cli_pub,
    sites_ledger_path, EdgeOneDeployResult, EdgeOneEnvVar, EdgeOneSiteDeployment,
    EdgeOneSiteHealth, EdgeOneSiteMetaPatch, EdgeOneSiteRecord, EdgeOneSourceInspection,
};
use futures_util::future::join_all;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_HISTORY_PER_SITE: usize = 20;
const MAX_INSPECT_FILES: u32 = 5000;
const HEALTH_CHECK_TIMEOUT_SECS: u64 = 6;
const ENV_CLI_TIMEOUT_SECS: u64 = 35;

static LEDGER_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SitesLedgerFile {
    #[serde(default = "default_schema_version")]
    schema_version: u32,
    #[serde(default)]
    sites: Vec<EdgeOneSiteRecord>,
}

fn default_schema_version() -> u32 {
    1
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_ledger_unlocked(paths: &AppPaths) -> SitesLedgerFile {
    let p = sites_ledger_path(paths);
    let Ok(raw) = fs::read_to_string(&p) else {
        return SitesLedgerFile::default();
    };
    serde_json::from_str::<SitesLedgerFile>(&raw).unwrap_or_default()
}

fn save_ledger_unlocked(paths: &AppPaths, ledger: &SitesLedgerFile) -> Result<(), String> {
    let p = sites_ledger_path(paths);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建站点记录目录失败: {e}"))?;
    }
    let json =
        serde_json::to_string_pretty(ledger).map_err(|e| format!("序列化站点记录失败: {e}"))?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("写入临时站点记录失败: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("保存站点记录失败: {e}"))?;
    Ok(())
}

fn normalize_and_sort_sites(sites: &mut [EdgeOneSiteRecord]) {
    for site in sites.iter_mut() {
        site.local_source_exists = site
            .local_source_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|p| Path::new(p).exists())
            .unwrap_or(false);
        if site.deploy_count == 0 {
            site.deploy_count = site.history.len().max(1) as u32;
        }
    }
    sites.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.deployed_at.cmp(&a.deployed_at))
            .then_with(|| a.project_name.cmp(&b.project_name))
    });
}

pub fn list_sites(paths: &AppPaths) -> Vec<EdgeOneSiteRecord> {
    let lock = LEDGER_LOCK.get_or_init(|| std::sync::Mutex::new(()));
    let _guard = lock.lock().ok();
    let mut ledger = load_ledger_unlocked(paths);
    normalize_and_sort_sites(&mut ledger.sites);
    ledger.sites
}

pub fn record_site_deployment(
    paths: &AppPaths,
    result: &EdgeOneDeployResult,
    source_path: Option<&Path>,
    source_label: &str,
    workspace_id: Option<String>,
    workspace_name: Option<String>,
    duration_ms: Option<u64>,
) -> Result<EdgeOneSiteRecord, String> {
    let lock = LEDGER_LOCK.get_or_init(|| std::sync::Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "站点账本锁不可用".to_string())?;

    let mut ledger = load_ledger_unlocked(paths);
    let now = now_epoch_ms();
    let local_path_str = source_path.map(|p| p.to_string_lossy().to_string());
    let local_exists = source_path.map(|p| p.exists()).unwrap_or(false);
    let dep_entry = EdgeOneSiteDeployment {
        id: result
            .deployment_id
            .clone()
            .unwrap_or_else(|| format!("dep-{now}")),
        url: result.url.clone(),
        deployment_id: result.deployment_id.clone(),
        environment: result.environment.clone(),
        area: result.area.clone(),
        source: source_label.to_string(),
        deployed_at: now,
        duration_ms: duration_ms.or(result.duration_ms),
    };

    let existing_idx = ledger.sites.iter().position(|s| {
        if let (Some(ref pid), Some(ref spid)) = (&result.project_id, &s.project_id) {
            if !pid.is_empty() && pid == spid {
                return true;
            }
        }
        s.project_name.eq_ignore_ascii_case(&result.project_name)
            && (s.workspace_id.is_none()
                || workspace_id.is_none()
                || s.workspace_id == workspace_id)
    });

    let updated = if let Some(idx) = existing_idx {
        let rec = &mut ledger.sites[idx];
        rec.project_name = result.project_name.clone();
        if result.project_id.is_some() {
            rec.project_id = result.project_id.clone();
        }
        rec.url = result.url.clone();
        if result.console_url.is_some() {
            rec.console_url = result.console_url.clone();
        }
        rec.environment = result.environment.clone();
        rec.area = result.area.clone();
        rec.source = source_label.to_string();
        if workspace_id.is_some() {
            rec.workspace_id = workspace_id;
        }
        if workspace_name.is_some() {
            rec.workspace_name = workspace_name;
        }
        if local_path_str.is_some() {
            rec.local_source_path = local_path_str;
            rec.local_source_exists = local_exists;
        }
        rec.deployed_at = now;
        rec.deploy_count = rec.deploy_count.saturating_add(1);
        rec.history.insert(0, dep_entry);
        rec.history.truncate(MAX_HISTORY_PER_SITE);
        rec.clone()
    } else {
        let site_id = result.project_id.clone().unwrap_or_else(|| {
            let ws_part = workspace_id.as_deref().unwrap_or("default");
            format!("{}::{}", ws_part, result.project_name.to_ascii_lowercase())
        });
        let rec = EdgeOneSiteRecord {
            id: site_id,
            project_name: result.project_name.clone(),
            project_id: result.project_id.clone(),
            url: result.url.clone(),
            console_url: result.console_url.clone(),
            environment: result.environment.clone(),
            area: result.area.clone(),
            source: source_label.to_string(),
            workspace_id,
            workspace_name,
            local_source_path: local_path_str,
            local_source_exists: local_exists,
            pinned: false,
            note: None,
            deployed_at: now,
            deploy_count: 1,
            history: vec![dep_entry],
        };
        ledger.sites.insert(0, rec.clone());
        rec
    };

    normalize_and_sort_sites(&mut ledger.sites);
    save_ledger_unlocked(paths, &ledger)?;
    Ok(updated)
}

pub fn update_site_meta(
    paths: &AppPaths,
    patch: EdgeOneSiteMetaPatch,
) -> Result<Vec<EdgeOneSiteRecord>, String> {
    let lock = LEDGER_LOCK.get_or_init(|| std::sync::Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "站点账本锁不可用".to_string())?;

    let mut ledger = load_ledger_unlocked(paths);
    let Some(site) = ledger.sites.iter_mut().find(|s| s.id == patch.id) else {
        return Err(format!("未找到站点记录: {}", patch.id));
    };
    if let Some(pinned) = patch.pinned {
        site.pinned = pinned;
    }
    if let Some(note) = patch.note {
        let trimmed = note.trim().to_string();
        site.note = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(160).collect())
        };
    }
    if let Some(raw_path) = patch.local_source_path {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            site.local_source_path = None;
            site.local_source_exists = false;
        } else {
            let expanded = expand_user_path(paths, trimmed);
            if !expanded.exists() {
                return Err(format!("关联路径不存在: {}", expanded.display()));
            }
            site.local_source_path = Some(expanded.to_string_lossy().to_string());
            site.local_source_exists = true;
        }
    }
    normalize_and_sort_sites(&mut ledger.sites);
    save_ledger_unlocked(paths, &ledger)?;
    Ok(ledger.sites)
}

pub fn remove_site_record(paths: &AppPaths, id: &str) -> Result<Vec<EdgeOneSiteRecord>, String> {
    let lock = LEDGER_LOCK.get_or_init(|| std::sync::Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "站点账本锁不可用".to_string())?;

    let mut ledger = load_ledger_unlocked(paths);
    ledger.sites.retain(|s| s.id != id);
    normalize_and_sort_sites(&mut ledger.sites);
    save_ledger_unlocked(paths, &ledger)?;
    Ok(ledger.sites)
}

fn walk_dir_stats(dir: &Path, count: &mut u32, bytes: &mut u64) {
    if *count >= MAX_INSPECT_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *count >= MAX_INSPECT_FILES {
            break;
        }
        let name = entry.file_name();
        if name == ".git" || name == "node_modules" || name == ".DS_Store" || name == ".edgeone" {
            continue;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            walk_dir_stats(&entry.path(), count, bytes);
        } else if ft.is_file() {
            *count = count.saturating_add(1);
            if let Ok(meta) = entry.metadata() {
                *bytes = bytes.saturating_add(meta.len());
            }
        }
    }
}

pub fn inspect_deploy_source(
    paths: &AppPaths,
    raw_path: &str,
) -> Result<EdgeOneSourceInspection, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("请先选择或拖入网站文件夹、单个 .html 文件或 .zip 压缩包".to_string());
    }
    let expanded = expand_user_path(paths, trimmed);
    let display_path = expanded.to_string_lossy().to_string();
    let name = expanded
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(trimmed)
        .to_string();

    let state = read_switch_state(paths);
    let suggested = resolve_project_name(
        &expanded,
        None,
        state.mcp.normalized_edgeone_project_name(),
    );

    if !expanded.exists() {
        return Ok(EdgeOneSourceInspection {
            path: display_path,
            exists: false,
            kind: "missing".to_string(),
            name,
            file_count: 0,
            total_bytes: 0,
            has_index_html: false,
            has_package_json: false,
            linked_project_name: None,
            suggested_project_name: suggested,
            valid: false,
            warning: Some("找不到该路径，请重新选择本地目录或文件".to_string()),
        });
    }

    if expanded.is_file() {
        let ext = expanded
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        let bytes = fs::metadata(&expanded).map(|m| m.len()).unwrap_or(0);
        if ext == "html" || ext == "htm" {
            return Ok(EdgeOneSourceInspection {
                path: display_path,
                exists: true,
                kind: "html".to_string(),
                name,
                file_count: 1,
                total_bytes: bytes,
                has_index_html: true,
                has_package_json: false,
                linked_project_name: None,
                suggested_project_name: suggested,
                valid: true,
                warning: None,
            });
        }
        if ext == "zip" {
            return Ok(EdgeOneSourceInspection {
                path: display_path,
                exists: true,
                kind: "zip".to_string(),
                name,
                file_count: 1,
                total_bytes: bytes,
                has_index_html: true,
                has_package_json: false,
                linked_project_name: None,
                suggested_project_name: suggested,
                valid: true,
                warning: None,
            });
        }
        return Ok(EdgeOneSourceInspection {
            path: display_path,
            exists: true,
            kind: "unsupported".to_string(),
            name,
            file_count: 1,
            total_bytes: bytes,
            has_index_html: false,
            has_package_json: false,
            linked_project_name: None,
            suggested_project_name: suggested,
            valid: false,
            warning: Some(format!(
                "不支持直接部署单个 .{ext} 文件，请选择网站目录、.html 文件或 .zip 包"
            )),
        });
    }

    // Directory
    let mut file_count = 0u32;
    let mut total_bytes = 0u64;
    walk_dir_stats(&expanded, &mut file_count, &mut total_bytes);
    let has_index_html =
        expanded.join("index.html").is_file() || expanded.join("index.htm").is_file();
    let has_package_json =
        expanded.join("package.json").is_file() || expanded.join("edgeone.json").is_file();
    let linked_project_name = read_linked_project_name(&expanded);

    let single_html_top = !has_index_html
        && !has_package_json
        && fs::read_dir(&expanded)
            .ok()
            .map(|rd| {
                rd.flatten()
                    .filter(|e| {
                        e.path().is_file()
                            && matches!(
                                e.path()
                                    .extension()
                                    .and_then(|s| s.to_str())
                                    .map(|s| s.to_ascii_lowercase())
                                    .as_deref(),
                                Some("html" | "htm")
                            )
                    })
                    .count()
                    == 1
            })
            .unwrap_or(false);

    let warning = if file_count == 0 {
        Some("目录内没有可部署的文件".to_string())
    } else if !has_index_html && !has_package_json && !single_html_top {
        Some("未检测到 index.html 或 package.json，访问根路径可能需要手动指定文件名".to_string())
    } else if single_html_top {
        Some("检测到单个 HTML 入口，部署时将自动补齐 index.html".to_string())
    } else {
        None
    };

    Ok(EdgeOneSourceInspection {
        path: display_path,
        exists: true,
        kind: "folder".to_string(),
        name,
        file_count,
        total_bytes,
        has_index_html: has_index_html || single_html_top,
        has_package_json,
        linked_project_name,
        suggested_project_name: suggested,
        valid: file_count > 0,
        warning,
    })
}

pub fn create_sample_site(paths: &AppPaths) -> Result<EdgeOneSourceInspection, String> {
    let suffix = format!("{:x}", now_epoch_ms() & 0xfffff);
    let sample_dir = edgeone_root_dir(paths)
        .join("samples")
        .join(format!("tako-demo-{suffix}"));
    fs::create_dir_all(&sample_dir).map_err(|e| format!("创建演示站点目录失败: {e}"))?;
    let html = r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Tako Web Page · 演示站点</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f8fb; --card: #ffffff; --text: #151927; --sub: #596174; --accent: #5147e5; --border: #e1e5ec; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1219; --card: #181d2a; --text: #f1f5f9; --sub: #9aa5b8; --accent: #7f77ff; --border: rgba(255,255,255,.1); } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--text); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; }
  main { width: min(560px, 100%); background: var(--card); border: 1px solid var(--border); border-radius: 18px; padding: 32px; box-shadow: 0 20px 50px rgba(21,25,39,.1); }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; background: rgba(81,71,229,.12); color: var(--accent); font-size: 12px; font-weight: 600; }
  h1 { margin: 14px 0 8px; font-size: 26px; letter-spacing: -0.02em; }
  p { margin: 0 0 18px; color: var(--sub); }
  .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 20px; }
  .box { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; font-size: 13px; }
  .box strong { display: block; font-size: 14px; margin-bottom: 2px; }
</style>
</head>
<body>
  <main>
    <span class="pill">⚡ Tako Web Page · 腾讯云 EdgeOne</span>
    <h1>你的网站已上线全球边缘节点</h1>
    <p>该页面由 Tako Switch 一键生成并部署至腾讯云 EdgeOne Makers。你可以直接编辑本地文件夹后在 Tako 中一键重新部署。</p>
    <div class="meta">
      <div class="box"><strong>HTTPS 公网直达</strong>自动签发 SSL 证书与边缘加速</div>
      <div class="box"><strong>AI 协同发布</strong>在 Claude / Codex 中一句话迭代更新</div>
    </div>
  </main>
</body>
</html>
"#;
    fs::write(sample_dir.join("index.html"), html)
        .map_err(|e| format!("写入演示页面失败: {e}"))?;
    inspect_deploy_source(paths, &sample_dir.to_string_lossy())
}

pub async fn check_sites_health(paths: &AppPaths, urls: Vec<String>) -> Vec<EdgeOneSiteHealth> {
    let state = read_switch_state(paths);
    let client = match apply_proxy_policy(
        Client::builder()
            .connect_timeout(Duration::from_secs(HEALTH_CHECK_TIMEOUT_SECS))
            .timeout(Duration::from_secs(HEALTH_CHECK_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(concat!("tako-switch/", env!("CARGO_PKG_VERSION"))),
        state.bypass_system_proxy,
    )
    .build()
    {
        Ok(c) => c,
        Err(e) => {
            let now = now_epoch_ms();
            return urls
                .into_iter()
                .map(|url| EdgeOneSiteHealth {
                    url,
                    reachable: false,
                    status_code: None,
                    latency_ms: 0,
                    checked_at: now,
                    error: Some(format!("初始化探测客户端失败: {e}")),
                })
                .collect();
        }
    };

    let tasks = urls.into_iter().map(|url| {
        let client = client.clone();
        async move {
            let started = Instant::now();
            let resp = match client.head(&url).send().await {
                Ok(r) if r.status().as_u16() == 405 || r.status().as_u16() == 501 => {
                    client.get(&url).send().await
                }
                other => other,
            };
            let latency_ms = started.elapsed().as_millis() as u64;
            let checked_at = now_epoch_ms();
            match resp {
                Ok(r) => {
                    let code = r.status().as_u16();
                    let reachable = code < 400;
                    EdgeOneSiteHealth {
                        url,
                        reachable,
                        status_code: Some(code),
                        latency_ms,
                        checked_at,
                        error: if reachable {
                            None
                        } else {
                            Some(format!("HTTP {code}"))
                        },
                    }
                }
                Err(e) => EdgeOneSiteHealth {
                    url,
                    reachable: false,
                    status_code: None,
                    latency_ms,
                    checked_at,
                    error: Some(if e.is_timeout() {
                        "连接超时".to_string()
                    } else {
                        "无法连接".to_string()
                    }),
                },
            }
        }
    });

    join_all(tasks).await
}

pub fn pick_deploy_source(kind: &str) -> Result<Option<String>, String> {
    let want_folder = kind.trim().eq_ignore_ascii_case("folder");

    #[cfg(target_os = "macos")]
    {
        let script = if want_folder {
            r#"POSIX path of (choose folder with prompt "选择要部署的网站文件夹")"#
        } else {
            r#"POSIX path of (choose file of type {"public.html", "html", "htm", "public.zip-archive", "zip"} with prompt "选择要部署的 HTML 文件或 ZIP 压缩包")"#
        };
        let out = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", script])
            .output()
            .map_err(|e| format!("打开系统文件选择器失败: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            if err.contains("-128") || err.to_ascii_lowercase().contains("cancel") {
                return Ok(None);
            }
            return Err(format!("文件选择取消或失败: {}", err.trim()));
        }
        let chosen = String::from_utf8_lossy(&out.stdout)
            .trim()
            .trim_end_matches('/')
            .to_string();
        if chosen.is_empty() {
            Ok(None)
        } else {
            Ok(Some(chosen))
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let ps_script = if want_folder {
            "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择要部署的网站文件夹'; if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $d.SelectedPath }"
        } else {
            "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Filter = 'Web Files (*.html;*.htm;*.zip)|*.html;*.htm;*.zip|All Files (*.*)|*.*'; if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $d.FileName }"
        };
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-STA", "-Command", ps_script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("打开系统文件选择器失败: {e}"))?;
        let chosen = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if chosen.is_empty() {
            Ok(None)
        } else {
            Ok(Some(chosen))
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut cmd = std::process::Command::new("zenity");
        if want_folder {
            cmd.args([
                "--file-selection",
                "--directory",
                "--title=选择要部署的网站文件夹",
            ]);
        } else {
            cmd.args([
                "--file-selection",
                "--file-filter=Web Files | *.html *.htm *.zip",
                "--title=选择要部署的 HTML 或 ZIP 文件",
            ]);
        }
        let out = cmd
            .output()
            .map_err(|e| format!("打开系统文件选择器失败: {e}"))?;
        if !out.status.success() {
            return Ok(None);
        }
        let chosen = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if chosen.is_empty() {
            Ok(None)
        } else {
            Ok(Some(chosen))
        }
    }
}

pub fn open_local_path(paths: &AppPaths, raw_path: &str) -> Result<(), String> {
    let target = expand_user_path(paths, raw_path);
    if !target.exists() {
        return Err(format!("本地路径不存在: {}", target.display()));
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("/usr/bin/open");
        if target.is_file() {
            cmd.arg("-R").arg(&target);
        } else {
            cmd.arg(&target);
        }
        cmd.spawn()
            .map_err(|e| format!("在访达中打开失败: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        if target.is_file() {
            cmd.arg(format!("/select,{}", target.display()));
        } else {
            cmd.arg(&target);
        }
        cmd.spawn()
            .map_err(|e| format!("在资源管理器中打开失败: {e}"))?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let open_target = if target.is_file() {
            target.parent().unwrap_or(target.as_path())
        } else {
            target.as_path()
        };
        std::process::Command::new("xdg-open")
            .arg(open_target)
            .spawn()
            .map_err(|e| format!("打开本地目录失败: {e}"))?;
        Ok(())
    }
}

async fn resolve_env_work_dir(
    paths: &AppPaths,
    project_path: &str,
    project_name: Option<&str>,
) -> Result<PathBuf, String> {
    let expanded = expand_user_path(paths, project_path);
    if !expanded.exists() {
        return Err("该项目本地目录不存在，无法操作环境变量（请先重新关联本地目录）".to_string());
    }
    let dir = if expanded.is_dir() {
        expanded
    } else {
        expanded
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "无法定位项目目录".to_string())?
    };

    if !dir.join(".edgeone").join("project.json").is_file() {
        if let Some(name) = project_name.map(str::trim).filter(|s| !s.is_empty()) {
            let runtime = ensure_edgeone_cli(paths, false, &|_| {}).await?;
            let link_args = vec![
                "makers".to_string(),
                "link".to_string(),
                "-n".to_string(),
                name.to_string(),
                "--mode".to_string(),
                "link_existing".to_string(),
                "--skip-env-sync".to_string(),
                "--json".to_string(),
            ];
            let out = run_edgeone_cli_pub(
                paths,
                &runtime,
                &link_args,
                Some(&dir),
                ENV_CLI_TIMEOUT_SECS,
                1,
                &HashMap::new(),
            )
            .await?;
            if !out.0 && !dir.join(".edgeone").join("project.json").is_file() {
                return Err(friendly_edgeone_error(&format!("{}\n{}", out.1, out.2)));
            }
        }
    }
    Ok(dir)
}

fn normalize_env_target(raw: Option<&str>) -> &'static str {
    match raw
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("preview") => "preview",
        _ => "production",
    }
}

pub fn parse_env_list_output(raw: &str, default_env: &str) -> Vec<EdgeOneEnvVar> {
    // 1. Try JSON payload if CLI outputs structured JSON
    if let Some(val) = extract_last_json_object(raw) {
        if let Some(arr) = val
            .get("envVars")
            .or_else(|| val.get("variables"))
            .or_else(|| val.get("data"))
            .and_then(Value::as_array)
        {
            let mut out = Vec::new();
            for item in arr {
                if let Some(key) = item
                    .get("key")
                    .or_else(|| item.get("name"))
                    .and_then(Value::as_str)
                {
                    let value = item
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let environment = item
                        .get("environment")
                        .or_else(|| item.get("env"))
                        .and_then(Value::as_str)
                        .unwrap_or(default_env)
                        .to_string();
                    out.push(EdgeOneEnvVar {
                        key: key.to_string(),
                        value,
                        environment,
                    });
                }
            }
            if !out.is_empty() {
                return out;
            }
        }
    }

    // 2. Parse ASCII / box table or KEY=VALUE lines
    let mut vars = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('┌')
            || trimmed.starts_with('├')
            || trimmed.starts_with('└')
            || trimmed.starts_with('─')
            || trimmed.starts_with("──")
            || trimmed.starts_with("Key")
            || trimmed.starts_with("KEY")
            || trimmed.starts_with("Name")
            || trimmed.starts_with('⚠')
            || trimmed.starts_with('✓')
            || trimmed.starts_with('ℹ')
        {
            continue;
        }
        // Box table row: │ KEY │ VALUE │ production │
        if trimmed.contains('│') || trimmed.contains('|') {
            let sep = if trimmed.contains('│') { '│' } else { '|' };
            let cols: Vec<&str> = trimmed
                .split(sep)
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .collect();
            if cols.len() >= 2 {
                let k = cols[0];
                let looks_header = k.eq_ignore_ascii_case("key")
                    || k.eq_ignore_ascii_case("name")
                    || k.eq_ignore_ascii_case("variable")
                    || k.chars().all(|c| c == '-' || c == '─' || c == '=');
                if !looks_header
                    && k.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                {
                    let val = cols[1].to_string();
                    let env_name = cols
                        .get(2)
                        .copied()
                        .filter(|e| {
                            e.eq_ignore_ascii_case("production")
                                || e.eq_ignore_ascii_case("preview")
                        })
                        .map(str::to_ascii_lowercase)
                        .unwrap_or_else(|| default_env.to_string());
                    let sig = format!("{k}::{env_name}");
                    if seen.insert(sig) {
                        vars.push(EdgeOneEnvVar {
                            key: k.to_string(),
                            value: val,
                            environment: env_name,
                        });
                    }
                    continue;
                }
            }
        }
        // KEY=VALUE fallback
        if let Some((k, v)) = trimmed.split_once('=') {
            let k = k.trim();
            if !k.is_empty()
                && k.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                let sig = format!("{k}::{default_env}");
                if seen.insert(sig) {
                    vars.push(EdgeOneEnvVar {
                        key: k.to_string(),
                        value: v.trim().trim_matches('"').to_string(),
                        environment: default_env.to_string(),
                    });
                }
            }
        }
    }
    vars
}

pub async fn env_list(
    paths: &AppPaths,
    project_path: &str,
    project_name: Option<&str>,
    environment: Option<&str>,
) -> Result<Vec<EdgeOneEnvVar>, String> {
    let env_name = normalize_env_target(environment);
    let dir = resolve_env_work_dir(paths, project_path, project_name).await?;
    let runtime = ensure_edgeone_cli(paths, false, &|_| {}).await?;
    let args = vec![
        "makers".to_string(),
        "env".to_string(),
        "ls".to_string(),
        "-e".to_string(),
        env_name.to_string(),
    ];
    let (ok, stdout, stderr) = run_edgeone_cli_pub(
        paths,
        &runtime,
        &args,
        Some(&dir),
        ENV_CLI_TIMEOUT_SECS,
        1,
        &HashMap::new(),
    )
    .await?;
    if !ok {
        return Err(friendly_edgeone_error(&format!("{stdout}\n{stderr}")));
    }
    Ok(parse_env_list_output(&stdout, env_name))
}

pub async fn env_set(
    paths: &AppPaths,
    project_path: &str,
    project_name: Option<&str>,
    key: &str,
    value: &str,
    environment: Option<&str>,
) -> Result<Vec<EdgeOneEnvVar>, String> {
    let clean_key = key.trim();
    if clean_key.is_empty()
        || !clean_key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err("环境变量名仅支持字母、数字和下划线".to_string());
    }
    let env_name = normalize_env_target(environment);
    let dir = resolve_env_work_dir(paths, project_path, project_name).await?;
    let runtime = ensure_edgeone_cli(paths, false, &|_| {}).await?;
    let args = vec![
        "makers".to_string(),
        "env".to_string(),
        "set".to_string(),
        clean_key.to_string(),
        value.to_string(),
        "-e".to_string(),
        env_name.to_string(),
    ];
    let (ok, stdout, stderr) = run_edgeone_cli_pub(
        paths,
        &runtime,
        &args,
        Some(&dir),
        ENV_CLI_TIMEOUT_SECS,
        1,
        &HashMap::new(),
    )
    .await?;
    if !ok {
        return Err(friendly_edgeone_error(&format!("{stdout}\n{stderr}")));
    }
    env_list(paths, project_path, project_name, Some(env_name)).await
}

pub async fn env_remove(
    paths: &AppPaths,
    project_path: &str,
    project_name: Option<&str>,
    key: &str,
    environment: Option<&str>,
) -> Result<Vec<EdgeOneEnvVar>, String> {
    let clean_key = key.trim();
    if clean_key.is_empty() {
        return Err("请指定要删除的环境变量名".to_string());
    }
    let env_name = normalize_env_target(environment);
    let dir = resolve_env_work_dir(paths, project_path, project_name).await?;
    let runtime = ensure_edgeone_cli(paths, false, &|_| {}).await?;
    let args = vec![
        "makers".to_string(),
        "env".to_string(),
        "rm".to_string(),
        clean_key.to_string(),
        "-e".to_string(),
        env_name.to_string(),
    ];
    let (ok, stdout, stderr) = run_edgeone_cli_pub(
        paths,
        &runtime,
        &args,
        Some(&dir),
        ENV_CLI_TIMEOUT_SECS,
        1,
        &HashMap::new(),
    )
    .await?;
    if !ok {
        return Err(friendly_edgeone_error(&format!("{stdout}\n{stderr}")));
    }
    env_list(paths, project_path, project_name, Some(env_name)).await
}

pub async fn env_pull(
    paths: &AppPaths,
    project_path: &str,
    project_name: Option<&str>,
    environment: Option<&str>,
) -> Result<String, String> {
    let env_name = normalize_env_target(environment);
    let dir = resolve_env_work_dir(paths, project_path, project_name).await?;
    let out_file = dir.join(if env_name == "preview" {
        ".env.preview.local"
    } else {
        ".env.local"
    });
    let runtime = ensure_edgeone_cli(paths, false, &|_| {}).await?;
    let args = vec![
        "makers".to_string(),
        "env".to_string(),
        "pull".to_string(),
        "-e".to_string(),
        env_name.to_string(),
        "-f".to_string(),
        out_file.to_string_lossy().to_string(),
    ];
    let (ok, stdout, stderr) = run_edgeone_cli_pub(
        paths,
        &runtime,
        &args,
        Some(&dir),
        ENV_CLI_TIMEOUT_SECS,
        1,
        &HashMap::new(),
    )
    .await?;
    if !ok {
        return Err(friendly_edgeone_error(&format!("{stdout}\n{stderr}")));
    }
    Ok(out_file.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn ledger_records_merges_pins_notes_and_removes_sites() {
        let tmp = TempDir::new().unwrap();
        let paths = AppPaths::for_test(tmp.path());
        let src_dir = tmp.path().join("my-site");
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(src_dir.join("index.html"), "<h1>Hi</h1>").unwrap();

        let dep1 = EdgeOneDeployResult {
            url: "https://demo-1.edgeone.app".to_string(),
            project_name: "demo-site".to_string(),
            project_id: Some("pages-001".to_string()),
            deployment_id: Some("dep-001".to_string()),
            console_url: Some("https://console.cloud.tencent.com/edgeone/pages/project/pages-001".to_string()),
            environment: "preview".to_string(),
            area: "global".to_string(),
            duration_ms: Some(1200),
        };
        record_site_deployment(
            &paths,
            &dep1,
            Some(&src_dir),
            "ui",
            Some("zone-1".to_string()),
            Some("个人空间".to_string()),
            Some(1200),
        )
        .unwrap();

        let sites = list_sites(&paths);
        assert_eq!(sites.len(), 1);
        assert_eq!(sites[0].project_name, "demo-site");
        assert!(sites[0].local_source_exists);
        assert_eq!(sites[0].deploy_count, 1);
        assert_eq!(sites[0].history.len(), 1);

        // Pin & add note
        let sites = update_site_meta(
            &paths,
            EdgeOneSiteMetaPatch {
                id: sites[0].id.clone(),
                pinned: Some(true),
                note: Some("客户预览页".to_string()),
                local_source_path: None,
            },
        )
        .unwrap();
        assert!(sites[0].pinned);
        assert_eq!(sites[0].note.as_deref(), Some("客户预览页"));

        // Second deploy to same project_id preserves pin/note & appends history
        let dep2 = EdgeOneDeployResult {
            url: "https://demo-prod.edgeone.app".to_string(),
            project_name: "demo-site".to_string(),
            project_id: Some("pages-001".to_string()),
            deployment_id: Some("dep-002".to_string()),
            console_url: None,
            environment: "production".to_string(),
            area: "global".to_string(),
            duration_ms: Some(900),
        };
        record_site_deployment(
            &paths,
            &dep2,
            Some(&src_dir),
            "mcp",
            Some("zone-1".to_string()),
            Some("个人空间".to_string()),
            Some(900),
        )
        .unwrap();

        let sites = list_sites(&paths);
        assert_eq!(sites.len(), 1);
        assert!(sites[0].pinned);
        assert_eq!(sites[0].note.as_deref(), Some("客户预览页"));
        assert_eq!(sites[0].deploy_count, 2);
        assert_eq!(sites[0].history.len(), 2);
        assert_eq!(sites[0].source, "mcp");
        assert_eq!(sites[0].environment, "production");

        let sites = remove_site_record(&paths, &sites[0].id).unwrap();
        assert!(sites.is_empty());
    }

    #[test]
    fn inspect_source_and_sample_site_work() {
        let tmp = TempDir::new().unwrap();
        let paths = AppPaths::for_test(tmp.path());
        let sample = create_sample_site(&paths).unwrap();
        assert!(sample.exists);
        assert!(sample.valid);
        assert!(sample.has_index_html);
        assert_eq!(sample.kind, "folder");
        assert_eq!(sample.file_count, 1);

        let missing = inspect_deploy_source(&paths, &tmp.path().join("nope").to_string_lossy()).unwrap();
        assert!(!missing.exists);
        assert!(!missing.valid);
    }

    #[test]
    fn parse_env_list_handles_table_and_kv_lines() {
        let table = r#"
┌──────────┬──────────────┬────────────┐
│ Key      │ Value        │ Env        │
├──────────┼──────────────┼────────────┤
│ API_BASE │ https://a.co │ production │
│ SITE_TAG │ beta-1       │ preview    │
└──────────┴──────────────┴────────────┘
"#;
        let parsed = parse_env_list_output(table, "production");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].key, "API_BASE");
        assert_eq!(parsed[0].value, "https://a.co");
        assert_eq!(parsed[0].environment, "production");
        assert_eq!(parsed[1].key, "SITE_TAG");
        assert_eq!(parsed[1].environment, "preview");

        let kv = "FOO=bar\nHELLO=\"world\"\n";
        let parsed_kv = parse_env_list_output(kv, "production");
        assert_eq!(parsed_kv.len(), 2);
        assert_eq!(parsed_kv[1].value, "world");
    }
}
