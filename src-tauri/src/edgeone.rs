use crate::adapters::{detect_node_runtime, parse_node_version};
use crate::config::{read_switch_state, save_switch_state, AppPaths};
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

pub const EDGEONE_MANAGED_NODE_VERSION: &str = "v22.14.0";
pub const EDGEONE_MIN_NODE_MAJOR: u32 = 18;
pub const EDGEONE_NPM_PACKAGE: &str = "edgeone@latest";
pub const NPMMIRROR_REGISTRY: &str = "https://registry.npmmirror.com";
pub const NPMJS_REGISTRY: &str = "https://registry.npmjs.org";
pub const NPMMIRROR_NODE_BASE: &str = "https://cdn.npmmirror.com/binaries/node";
pub const OFFICIAL_NODE_BASE: &str = "https://nodejs.org/dist";

const CLI_QUICK_TIMEOUT_SECS: u64 = 30;
const CLI_DEPLOY_TIMEOUT_SECS: u64 = 180;
const CLI_NPM_INSTALL_TIMEOUT_SECS: u64 = 240;
const CLI_LOGIN_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeOneWorkspace {
    pub id: String,
    pub name: String,
    pub plan: String,
    pub status: String,
    pub available: bool,
    pub current: bool,
    pub cached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeOneStatus {
    pub node_available: bool,
    pub node_version: Option<String>,
    pub node_managed: bool,
    pub cli_installed: bool,
    pub cli_version: Option<String>,
    pub cli_path: Option<String>,
    pub ready: bool,
    pub has_local_credentials: bool,
    pub authenticated: bool,
    pub auth_mode: String,
    pub account_name: Option<String>,
    pub account_id: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub plan: Option<String>,
    pub workspace_status: Option<String>,
    pub workspaces: Vec<EdgeOneWorkspace>,
    pub error: Option<String>,
}

impl EdgeOneStatus {
    fn base(
        node_available: bool,
        node_version: Option<String>,
        node_managed: bool,
        cli_installed: bool,
        cli_version: Option<String>,
        cli_path: Option<String>,
    ) -> Self {
        Self {
            ready: node_available && cli_installed,
            node_available,
            node_version,
            node_managed,
            cli_installed,
            cli_version,
            cli_path,
            has_local_credentials: false,
            authenticated: false,
            auth_mode: "none".to_string(),
            account_name: None,
            account_id: None,
            workspace_id: None,
            workspace_name: None,
            plan: None,
            workspace_status: None,
            workspaces: Vec::new(),
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeOneProgressEvent {
    pub stage: String,
    pub percent: u8,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeOneDeployRequest {
    pub path: String,
    pub project_name: Option<String>,
    pub environment: Option<String>,
    pub area: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeOneDeployResult {
    pub url: String,
    pub project_name: String,
    pub project_id: Option<String>,
    pub deployment_id: Option<String>,
    pub console_url: Option<String>,
    pub environment: String,
    pub area: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedNode {
    pub node_exe: PathBuf,
    pub npm_cli_js: Option<PathBuf>,
    pub npm_exe: Option<PathBuf>,
    pub version: String,
    pub major: u32,
    pub managed: bool,
}

#[derive(Debug, Clone)]
pub struct ResolvedEdgeOneRuntime {
    pub node: ResolvedNode,
    pub cli_entry: PathBuf,
    pub cli_version: String,
}

#[derive(Default)]
pub struct EdgeOneLoginGuard {
    cancel_tx: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl EdgeOneLoginGuard {
    pub fn new() -> Self {
        Self::default()
    }

    fn replace(&self, tx: oneshot::Sender<()>) {
        if let Ok(mut guard) = self.cancel_tx.lock() {
            if let Some(prev) = guard.replace(tx) {
                let _ = prev.send(());
            }
        }
    }

    pub fn cancel(&self) -> bool {
        if let Ok(mut guard) = self.cancel_tx.lock() {
            if let Some(prev) = guard.take() {
                let _ = prev.send(());
                return true;
            }
        }
        false
    }

    fn clear(&self) {
        if let Ok(mut guard) = self.cancel_tx.lock() {
            *guard = None;
        }
    }
}

pub struct EdgeOneOpLock(pub Mutex<()>);

impl Default for EdgeOneOpLock {
    fn default() -> Self {
        Self(Mutex::new(()))
    }
}

pub fn edgeone_root_dir(paths: &AppPaths) -> PathBuf {
    paths.switch_dir().join("edgeone")
}

pub fn managed_node_root(paths: &AppPaths) -> PathBuf {
    edgeone_root_dir(paths).join("node")
}

pub fn managed_node_install_dir(paths: &AppPaths) -> PathBuf {
    managed_node_root(paths).join(EDGEONE_MANAGED_NODE_VERSION)
}

pub fn managed_cli_dir(paths: &AppPaths) -> PathBuf {
    edgeone_root_dir(paths).join("cli")
}

pub fn managed_cli_entry(paths: &AppPaths) -> PathBuf {
    managed_cli_dir(paths)
        .join("node_modules")
        .join("edgeone")
        .join("edgeone-bin")
        .join("edgeone.js")
}

pub fn managed_cli_package_json(paths: &AppPaths) -> PathBuf {
    managed_cli_dir(paths)
        .join("node_modules")
        .join("edgeone")
        .join("package.json")
}

fn managed_node_exe_in_dir(dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        dir.join("node.exe")
    }
    #[cfg(not(windows))]
    {
        dir.join("bin").join("node")
    }
}

fn find_npm_cli_js_near_node(node_exe: &Path) -> Option<PathBuf> {
    let bin_dir = node_exe.parent()?;
    let candidates = [
        // Portable Windows / Windows official installer layout
        bin_dir
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js"),
        // Unix / macOS layout: <prefix>/bin/node -> <prefix>/lib/node_modules/npm/bin/npm-cli.js
        bin_dir
            .parent()
            .map(|p| {
                p.join("lib")
                    .join("node_modules")
                    .join("npm")
                    .join("bin")
                    .join("npm-cli.js")
            })
            .unwrap_or_default(),
    ];
    candidates
        .into_iter()
        .find(|p| !p.as_os_str().is_empty() && p.is_file())
}

fn find_npm_exe_near_node(node_exe: &Path) -> Option<PathBuf> {
    let bin_dir = node_exe.parent()?;
    #[cfg(windows)]
    let names = ["npm.cmd", "npm.exe"];
    #[cfg(not(windows))]
    let names = ["npm"];

    for name in names {
        let p = bin_dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn probe_node_version_sync(node_exe: &Path) -> Option<(String, u32)> {
    let mut cmd = std::process::Command::new(node_exe);
    cmd.arg("-v");
    apply_no_window_std(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_node_version(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(windows)]
fn apply_no_window_std(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_no_window_std(_cmd: &mut std::process::Command) {}

#[cfg(windows)]
fn apply_no_window_tokio(cmd: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_no_window_tokio(_cmd: &mut Command) {}

pub fn resolve_managed_node(paths: &AppPaths) -> Option<ResolvedNode> {
    let root = managed_node_root(paths);
    if !root.is_dir() {
        return None;
    }
    let preferred = managed_node_exe_in_dir(&managed_node_install_dir(paths));
    let mut candidates = Vec::new();
    if preferred.is_file() {
        candidates.push(preferred);
    }
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let p = managed_node_exe_in_dir(&entry.path());
            if p.is_file() && !candidates.contains(&p) {
                candidates.push(p);
            }
        }
    }
    for exe in candidates {
        if let Some((version, major)) = probe_node_version_sync(&exe) {
            if major >= EDGEONE_MIN_NODE_MAJOR {
                return Some(ResolvedNode {
                    npm_cli_js: find_npm_cli_js_near_node(&exe),
                    npm_exe: find_npm_exe_near_node(&exe),
                    node_exe: exe,
                    version,
                    major,
                    managed: true,
                });
            }
        }
    }
    None
}

pub fn resolve_node_runtime(paths: &AppPaths) -> Option<ResolvedNode> {
    if let Some(managed) = resolve_managed_node(paths) {
        return Some(managed);
    }
    let sys = detect_node_runtime();
    if sys.available && sys.meets_min_version {
        if let (Some(node_str), Some(version), Some(major)) =
            (sys.node_path, sys.version, sys.major)
        {
            let node_exe = PathBuf::from(node_str);
            if node_exe.is_file() {
                return Some(ResolvedNode {
                    npm_cli_js: find_npm_cli_js_near_node(&node_exe),
                    npm_exe: find_npm_exe_near_node(&node_exe),
                    node_exe,
                    version,
                    major,
                    managed: false,
                });
            }
        }
    }
    None
}

pub fn read_managed_cli_version(paths: &AppPaths) -> Option<String> {
    let entry = managed_cli_entry(paths);
    if !entry.is_file() {
        return None;
    }
    let pkg_path = managed_cli_package_json(paths);
    let raw = fs::read_to_string(&pkg_path).ok()?;
    let val: Value = serde_json::from_str(&raw).ok()?;
    val.get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn resolve_edgeone_runtime(paths: &AppPaths) -> Option<ResolvedEdgeOneRuntime> {
    let node = resolve_node_runtime(paths)?;
    let cli_entry = managed_cli_entry(paths);
    let cli_version = read_managed_cli_version(paths)?;
    Some(ResolvedEdgeOneRuntime {
        node,
        cli_entry,
        cli_version,
    })
}

pub fn has_local_edgeone_credentials(paths: &AppPaths) -> bool {
    let dir = paths.home.join(".edgeone");
    let Ok(entries) = fs::read_dir(&dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .metadata()
            .map(|m| m.is_file() && m.len() > 0)
            .unwrap_or(false)
    })
}

fn node_archive_filename_for(os: &str, arch: &str, version: &str) -> Result<String, String> {
    let suffix = match (os, arch) {
        ("macos", "aarch64") => "darwin-arm64.tar.gz",
        ("macos", "x86_64") => "darwin-x64.tar.gz",
        ("windows", "x86_64") => "win-x64.zip",
        ("windows", "aarch64") => "win-arm64.zip",
        ("linux", "x86_64") => "linux-x64.tar.gz",
        ("linux", "aarch64") => "linux-arm64.tar.gz",
        _ => return Err(format!("当前平台 ({os}/{arch}) 暂不支持自动下载 Node.js")),
    };
    Ok(format!("node-{version}-{suffix}"))
}

fn node_archive_urls(version: &str) -> Result<(String, Vec<String>), String> {
    let filename = node_archive_filename_for(std::env::consts::OS, std::env::consts::ARCH, version)?;
    let urls = vec![
        format!("{NPMMIRROR_NODE_BASE}/{version}/{filename}"),
        format!("{OFFICIAL_NODE_BASE}/{version}/{filename}"),
    ];
    Ok((filename, urls))
}

fn build_download_client(bypass_proxy: bool) -> Result<Client, String> {
    crate::config::apply_proxy_policy(
        Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .user_agent(concat!("tako-switch/", env!("CARGO_PKG_VERSION"))),
        bypass_proxy,
    )
    .build()
    .map_err(|e| format!("初始化下载客户端失败: {e}"))
}

async fn download_file_with_progress<F>(
    client: &Client,
    urls: &[String],
    dest: &Path,
    mut on_progress: F,
) -> Result<(), String>
where
    F: FnMut(u8, u64, Option<u64>),
{
    let mut last_err = String::from("无可用下载地址");
    for url in urls {
        let resp = match client.get(url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                last_err = format!("下载源返回 HTTP {} ({url})", r.status());
                continue;
            }
            Err(e) => {
                last_err = format!("连接下载源失败 ({url}): {e}");
                continue;
            }
        };

        let total = resp.content_length();
        let tmp = dest.with_extension("part");
        if let Some(parent) = tmp.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建临时目录失败: {e}"))?;
        }
        let mut file = fs::File::create(&tmp).map_err(|e| format!("创建下载缓存文件失败: {e}"))?;
        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut last_pct: u8 = 0;
        let mut failed = false;

        while let Some(chunk_res) = stream.next().await {
            match chunk_res {
                Ok(chunk) => {
                    if let Err(e) = file.write_all(&chunk) {
                        last_err = format!("写入下载文件失败: {e}");
                        failed = true;
                        break;
                    }
                    downloaded = downloaded.saturating_add(chunk.len() as u64);
                    let pct = total
                        .filter(|&t| t > 0)
                        .map(|t| ((downloaded.saturating_mul(100)) / t).min(100) as u8)
                        .unwrap_or(0);
                    if pct != last_pct || total.is_none() {
                        last_pct = pct;
                        on_progress(pct, downloaded, total);
                    }
                }
                Err(e) => {
                    last_err = format!("下载中断 ({url}): {e}");
                    failed = true;
                    break;
                }
            }
        }

        drop(file);
        if failed {
            let _ = fs::remove_file(&tmp);
            continue;
        }
        fs::rename(&tmp, dest).map_err(|e| format!("保存下载文件失败: {e}"))?;
        return Ok(());
    }
    Err(last_err)
}

fn extract_node_archive(archive_path: &Path, extract_root: &Path) -> Result<PathBuf, String> {
    if extract_root.exists() {
        let _ = fs::remove_dir_all(extract_root);
    }
    fs::create_dir_all(extract_root).map_err(|e| format!("创建解压目录失败: {e}"))?;

    let file_name = archive_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if file_name.ends_with(".zip") {
        let file = fs::File::open(archive_path).map_err(|e| format!("打开 ZIP 包失败: {e}"))?;
        let mut zip =
            zip::ZipArchive::new(file).map_err(|e| format!("解析 Node.js ZIP 压缩包失败: {e}"))?;
        for i in 0..zip.len() {
            let mut entry = zip
                .by_index(i)
                .map_err(|e| format!("读取 ZIP 条目失败: {e}"))?;
            let Some(enclosed) = entry.enclosed_name() else {
                continue;
            };
            let out_path = extract_root.join(enclosed);
            if entry.is_dir() {
                fs::create_dir_all(&out_path).map_err(|e| format!("创建解压子目录失败: {e}"))?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("创建解压父目录失败: {e}"))?;
                }
                let mut out_file =
                    fs::File::create(&out_path).map_err(|e| format!("写入解压文件失败: {e}"))?;
                std::io::copy(&mut entry, &mut out_file)
                    .map_err(|e| format!("解压文件失败: {e}"))?;
            }
        }
    } else {
        #[cfg(not(windows))]
        {
            let tar_bin = if Path::new("/usr/bin/tar").is_file() {
                "/usr/bin/tar"
            } else {
                "tar"
            };
            let out = std::process::Command::new(tar_bin)
                .arg("-xzf")
                .arg(archive_path)
                .arg("-C")
                .arg(extract_root)
                .output()
                .map_err(|e| format!("执行 tar 解压失败: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "解压 Node.js 安装包失败: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
        }
        #[cfg(windows)]
        {
            return Err("Windows 平台不支持 .tar.gz 格式的 Node.js 压缩包".to_string());
        }
    }

    // Locate the single top-level extracted folder (e.g., node-v22.14.0-darwin-arm64)
    let mut dirs = fs::read_dir(extract_root)
        .map_err(|e| format!("读取解压目录失败: {e}"))?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.path());
    dirs.next()
        .ok_or_else(|| "解压 Node.js 压缩包后未找到有效目录".to_string())
}

pub async fn ensure_node_runtime<F>(paths: &AppPaths, emit: &F) -> Result<ResolvedNode, String>
where
    F: Fn(EdgeOneProgressEvent),
{
    if let Some(existing) = resolve_node_runtime(paths) {
        return Ok(existing);
    }

    emit(EdgeOneProgressEvent {
        stage: "node".to_string(),
        percent: 5,
        message: format!(
            "未检测到 Node.js 18+，正在从国内镜像自动准备 Node.js {EDGEONE_MANAGED_NODE_VERSION}..."
        ),
        login_url: None,
    });

    let (filename, urls) = node_archive_urls(EDGEONE_MANAGED_NODE_VERSION)?;
    let state = read_switch_state(paths);
    let client = build_download_client(state.bypass_system_proxy)?;
    let cache_dir = edgeone_root_dir(paths).join("tmp");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("创建临时缓存目录失败: {e}"))?;
    let archive_path = cache_dir.join(&filename);

    download_file_with_progress(&client, &urls, &archive_path, |pct, dl, total| {
        let mapped = 5u8.saturating_add(((pct as u16) * 35 / 100) as u8);
        let mb_dl = (dl as f64) / (1024.0 * 1024.0);
        let detail = if let Some(t) = total {
            format!("{mb_dl:.1} / {:.1} MB", (t as f64) / (1024.0 * 1024.0))
        } else {
            format!("{mb_dl:.1} MB")
        };
        emit(EdgeOneProgressEvent {
            stage: "node".to_string(),
            percent: mapped,
            message: format!("正在下载内置 Node.js 运行环境 ({detail})..."),
            login_url: None,
        });
    })
    .await?;

    emit(EdgeOneProgressEvent {
        stage: "node".to_string(),
        percent: 42,
        message: "正在解压内置 Node.js 运行环境...".to_string(),
        login_url: None,
    });

    let extract_root = cache_dir.join("node-extract");
    let archive_clone = archive_path.clone();
    let extract_clone = extract_root.clone();
    let extracted_dir = tokio::task::spawn_blocking(move || {
        extract_node_archive(&archive_clone, &extract_clone)
    })
    .await
    .map_err(|e| format!("解压任务中断: {e}"))??;

    let final_dir = managed_node_install_dir(paths);
    if let Some(parent) = final_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 Node.js 托管目录失败: {e}"))?;
    }
    if final_dir.exists() {
        let _ = fs::remove_dir_all(&final_dir);
    }
    fs::rename(&extracted_dir, &final_dir).map_err(|e| format!("安装内置 Node.js 失败: {e}"))?;
    let _ = fs::remove_file(&archive_path);
    let _ = fs::remove_dir_all(&extract_root);

    resolve_managed_node(paths)
        .ok_or_else(|| "内置 Node.js 解压完成但无法启动，请检查权限后重试".to_string())
}

fn prepend_path_env(dir: Option<&Path>) -> Option<std::ffi::OsString> {
    let dir = dir?;
    let mut paths_vec = vec![dir.to_path_buf()];
    if let Some(existing) = std::env::var_os("PATH") {
        paths_vec.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(paths_vec).ok()
}

async fn run_npm_install_once(
    node: &ResolvedNode,
    cli_dir: &Path,
    registry: &str,
) -> Result<(), String> {
    let mut cmd = if let Some(ref npm_cli_js) = node.npm_cli_js {
        let mut c = Command::new(&node.node_exe);
        c.arg(npm_cli_js);
        c
    } else if let Some(ref npm_exe) = node.npm_exe {
        Command::new(npm_exe)
    } else {
        return Err(format!(
            "在 {} 附近未找到 npm，无法安装 EdgeOne 组件",
            node.node_exe.display()
        ));
    };

    cmd.current_dir(cli_dir)
        .args([
            "install",
            "--no-audit",
            "--no-fund",
            "--omit=dev",
            "--loglevel=error",
            &format!("--registry={registry}"),
            EDGEONE_NPM_PACKAGE,
        ])
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("npm_config_update_notifier", "false")
        .env("npm_config_fund", "false")
        .env("npm_config_audit", "false")
        .kill_on_drop(true);

    if let Some(path_val) = prepend_path_env(node.node_exe.parent()) {
        cmd.env("PATH", path_val);
    }
    apply_no_window_tokio(&mut cmd);

    let output = tokio::time::timeout(
        Duration::from_secs(CLI_NPM_INSTALL_TIMEOUT_SECS),
        cmd.output(),
    )
    .await
    .map_err(|_| format!("安装 EdgeOne 组件超时（超过 {CLI_NPM_INSTALL_TIMEOUT_SECS} 秒）"))?
    .map_err(|e| format!("启动 npm 安装失败: {e}"))?;

    if !output.status.success() {
        let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
        let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
        let detail = if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        let snippet: String = detail.chars().take(400).collect();
        return Err(format!("npm 安装失败（{registry}）：{snippet}"));
    }

    Ok(())
}

pub async fn ensure_edgeone_cli<F>(
    paths: &AppPaths,
    force_upgrade: bool,
    emit: &F,
) -> Result<ResolvedEdgeOneRuntime, String>
where
    F: Fn(EdgeOneProgressEvent),
{
    let node = ensure_node_runtime(paths, emit).await?;

    if !force_upgrade {
        if let Some(existing_ver) = read_managed_cli_version(paths) {
            return Ok(ResolvedEdgeOneRuntime {
                node,
                cli_entry: managed_cli_entry(paths),
                cli_version: existing_ver,
            });
        }
    }

    let cli_dir = managed_cli_dir(paths);
    fs::create_dir_all(&cli_dir).map_err(|e| format!("创建 EdgeOne 托管目录失败: {e}"))?;
    let pkg_json = cli_dir.join("package.json");
    if !pkg_json.exists() {
        fs::write(
            &pkg_json,
            "{\n  \"name\": \"tako-edgeone-runtime\",\n  \"private\": true\n}\n",
        )
        .map_err(|e| format!("写入托管 package.json 失败: {e}"))?;
    }

    emit(EdgeOneProgressEvent {
        stage: "cli".to_string(),
        percent: 55,
        message: if force_upgrade {
            "正在从国内镜像更新 EdgeOne 部署组件...".to_string()
        } else {
            "正在从国内镜像安装 EdgeOne 部署组件（首次约需 10~20 秒）...".to_string()
        },
        login_url: None,
    });

    if let Err(mirror_err) = run_npm_install_once(&node, &cli_dir, NPMMIRROR_REGISTRY).await {
        emit(EdgeOneProgressEvent {
            stage: "cli".to_string(),
            percent: 72,
            message: "国内镜像暂不可用，正在自动切换官方源安装 EdgeOne 组件...".to_string(),
            login_url: None,
        });
        run_npm_install_once(&node, &cli_dir, NPMJS_REGISTRY)
            .await
            .map_err(|official_err| {
                format!("安装 EdgeOne 部署组件失败。\n镜像源：{mirror_err}\n官方源：{official_err}")
            })?;
    }

    let cli_entry = managed_cli_entry(paths);
    let cli_version = read_managed_cli_version(paths).ok_or_else(|| {
        format!(
            "EdgeOne 组件安装完成但未找到入口文件 {}",
            cli_entry.display()
        )
    })?;

    emit(EdgeOneProgressEvent {
        stage: "cli".to_string(),
        percent: 88,
        message: format!("EdgeOne 组件 v{cli_version} 已就绪"),
        login_url: None,
    });

    Ok(ResolvedEdgeOneRuntime {
        node,
        cli_entry,
        cli_version,
    })
}

pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            if matches!(chars.peek(), Some('[')) {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
                continue;
            }
            if matches!(chars.peek(), Some(']')) {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' && matches!(chars.peek(), Some('\\')) {
                        chars.next();
                        break;
                    }
                }
                continue;
            }
        }
        out.push(ch);
    }
    out
}

pub fn extract_last_json_object(raw: &str) -> Option<Value> {
    let clean = strip_ansi(raw);
    for line in clean.lines().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') && trimmed.ends_with('}') {
            if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                if val.is_object() {
                    return Some(val);
                }
            }
        }
    }
    // Fallback: whole trimmed text is pretty-printed JSON
    let trimmed = clean.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
            if val.is_object() {
                return Some(val);
            }
        }
    }
    None
}

pub fn extract_login_url(line: &str) -> Option<String> {
    let clean = strip_ansi(line);
    let trimmed = clean.trim();
    // Check structured JSON line first: {"status":"waiting","loginUrl":"https://..."}
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
            if let Some(url) = val.get("loginUrl").and_then(Value::as_str) {
                let u = url.trim();
                if u.starts_with("https://") || u.starts_with("http://") {
                    return Some(u.to_string());
                }
            }
        }
    }
    for token in clean.split_whitespace() {
        let candidate = token.trim_matches(|c: char| matches!(c, '"' | '\'' | '(' | ')' | '<' | '>' | ',' | ';'));
        if (candidate.starts_with("https://") || candidate.starts_with("http://"))
            && (candidate.contains("tencent")
                || candidate.contains("edgeone")
                || candidate.contains("login"))
        {
            return Some(candidate.to_string());
        }
    }
    None
}

pub fn is_transient_network_error(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    [
        "econnreset",
        "etimedout",
        "econnrefused",
        "eai_again",
        "socket hang up",
        "tls handshake",
        "network error",
        "fetch failed",
        "enotfound",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

struct CliOutput {
    success: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl CliOutput {
    fn combined(&self) -> String {
        let mut s = String::new();
        if !self.stdout.trim().is_empty() {
            s.push_str(self.stdout.trim());
        }
        if !self.stderr.trim().is_empty() {
            if !s.is_empty() {
                s.push('\n');
            }
            s.push_str(self.stderr.trim());
        }
        s
    }
}

async fn run_edgeone_cli(
    paths: &AppPaths,
    runtime: &ResolvedEdgeOneRuntime,
    args: &[String],
    cwd: Option<&Path>,
    timeout_secs: u64,
    max_retries: usize,
    extra_env: &HashMap<String, String>,
) -> Result<CliOutput, String> {
    let state = read_switch_state(paths);
    let mut attempt = 0usize;

    loop {
        let mut cmd = Command::new(&runtime.node.node_exe);
        cmd.arg(&runtime.cli_entry)
            .args(args)
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .env("FORCE_NON_TTY", "1")
            .env("EDGEONE_NON_INTERACTIVE", "1")
            .env("PAGES_SOURCE", "mcp")
            .kill_on_drop(true);

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        if let Some(path_val) = prepend_path_env(runtime.node.node_exe.parent()) {
            cmd.env("PATH", path_val);
        }
        if let Some(token) = state.mcp.normalized_edgeone_api_token() {
            cmd.env("EDGEONE_PAGES_API_TOKEN", token);
        }
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        apply_no_window_tokio(&mut cmd);

        let res = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output()).await;
        match res {
            Ok(Ok(out)) => {
                let parsed = CliOutput {
                    success: out.status.success(),
                    exit_code: out.status.code(),
                    stdout: strip_ansi(&String::from_utf8_lossy(&out.stdout)),
                    stderr: strip_ansi(&String::from_utf8_lossy(&out.stderr)),
                };
                if parsed.success {
                    return Ok(parsed);
                }
                let combined = parsed.combined();
                if attempt < max_retries && is_transient_network_error(&combined) {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(600 * attempt as u64)).await;
                    continue;
                }
                return Ok(parsed);
            }
            Ok(Err(e)) => {
                return Err(format!("启动 EdgeOne CLI 失败: {e}"));
            }
            Err(_) => {
                if attempt < max_retries {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(600 * attempt as u64)).await;
                    continue;
                }
                return Err(format!("调用腾讯云 EdgeOne 超时（超过 {timeout_secs} 秒）"));
            }
        }
    }
}

fn format_workspace_plan(raw: &str) -> String {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix("plan-")
        .or_else(|| trimmed.strip_prefix("PLAN_"))
        .unwrap_or(trimmed);
    let mut chars = stripped.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

fn parse_workspaces_json(val: &Value) -> Vec<EdgeOneWorkspace> {
    val.get("workspaces")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(Value::as_str)?.trim().to_string();
                    if id.is_empty() {
                        return None;
                    }
                    let name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&id)
                        .to_string();
                    let plan = item
                        .get("plan")
                        .and_then(Value::as_str)
                        .map(format_workspace_plan)
                        .unwrap_or_default();
                    let status = item
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    Some(EdgeOneWorkspace {
                        id,
                        name,
                        plan,
                        status,
                        available: item
                            .get("available")
                            .and_then(Value::as_bool)
                            .unwrap_or(true),
                        current: item
                            .get("current")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        cached: item
                            .get("cached")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub async fn get_status(paths: &AppPaths, refresh_account: bool) -> EdgeOneStatus {
    let node = resolve_node_runtime(paths);
    let cli_version = read_managed_cli_version(paths);
    let cli_entry = managed_cli_entry(paths);
    let cli_installed = cli_version.is_some();

    let mut status = EdgeOneStatus::base(
        node.is_some(),
        node.as_ref().map(|n| n.version.clone()),
        node.as_ref().map(|n| n.managed).unwrap_or(false),
        cli_installed,
        cli_version.clone(),
        cli_installed.then(|| cli_entry.to_string_lossy().to_string()),
    );

    let state = read_switch_state(paths);
    let has_token = state.mcp.normalized_edgeone_api_token().is_some();
    let has_local = has_local_edgeone_credentials(paths);
    status.has_local_credentials = has_local || has_token;

    if !status.ready {
        if has_token {
            status.auth_mode = "api_token".to_string();
        }
        return status;
    }

    if !refresh_account && !has_token && !has_local {
        return status;
    }

    let runtime = ResolvedEdgeOneRuntime {
        node: node.unwrap(),
        cli_entry,
        cli_version: cli_version.unwrap(),
    };

    let whoami_args = vec!["whoami".to_string(), "--json".to_string()];
    let empty_env = HashMap::new();
    match run_edgeone_cli(
        paths,
        &runtime,
        &whoami_args,
        None,
        CLI_QUICK_TIMEOUT_SECS,
        2,
        &empty_env,
    )
    .await
    {
        Ok(out) => {
            if let Some(json) = extract_last_json_object(&out.stdout) {
                let authed = json
                    .get("authenticated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if authed {
                    status.authenticated = true;
                    status.auth_mode = if has_token {
                        "api_token".to_string()
                    } else {
                        "login".to_string()
                    };
                    status.account_name = json
                        .get("accountName")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && *s != "-")
                        .map(str::to_string);
                    status.account_id = json
                        .get("accountId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && *s != "-")
                        .map(str::to_string);
                    status.workspace_id = json
                        .get("workspaceId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && *s != "-")
                        .map(str::to_string);
                    status.workspace_name = json
                        .get("workspaceName")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && *s != "-")
                        .map(str::to_string);
                    status.plan = json
                        .get("plan")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && *s != "-")
                        .map(str::to_string);
                    status.workspace_status = json
                        .get("workspaceStatus")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && *s != "-")
                        .map(str::to_string);
                } else {
                    status.authenticated = false;
                    status.auth_mode = "none".to_string();
                    if has_token {
                        status.error = Some(
                            "配置的 EDGEONE_PAGES_API_TOKEN 无效或已过期，请检查或清空后使用一键浏览器登录"
                                .to_string(),
                        );
                    }
                }
            } else if !out.success {
                let combined = out.combined();
                if is_auth_failure_text(&combined) {
                    status.authenticated = false;
                    status.auth_mode = "none".to_string();
                } else {
                    status.error = Some(friendly_edgeone_error(&combined));
                }
            }
        }
        Err(err) => {
            status.error = Some(err);
        }
    }

    if status.authenticated && status.auth_mode == "login" {
        let ws_args = vec![
            "workspace".to_string(),
            "ls".to_string(),
            "--json".to_string(),
        ];
        if let Ok(ws_out) = run_edgeone_cli(
            paths,
            &runtime,
            &ws_args,
            None,
            CLI_QUICK_TIMEOUT_SECS,
            2,
            &empty_env,
        )
        .await
        {
            if let Some(val) = extract_last_json_object(&ws_out.stdout) {
                status.workspaces = parse_workspaces_json(&val);
            }
        }
    }

    status
}

pub async fn start_login<F>(
    paths: &AppPaths,
    site: &str,
    login_guard: &EdgeOneLoginGuard,
    emit: F,
) -> Result<EdgeOneStatus, String>
where
    F: Fn(EdgeOneProgressEvent) + Send + Sync + 'static,
{
    let emit = Arc::new(emit);
    let runtime = ensure_edgeone_cli(paths, false, &|ev| emit(ev)).await?;

    let normalized_site = match site.trim().to_ascii_lowercase().as_str() {
        "global" => "global",
        _ => "china",
    };

    emit(EdgeOneProgressEvent {
        stage: "login".to_string(),
        percent: 90,
        message: "正在拉起腾讯云 EdgeOne 浏览器授权...".to_string(),
        login_url: None,
    });

    let mut cmd = Command::new(&runtime.node.node_exe);
    cmd.arg(&runtime.cli_entry)
        .args([
            "login",
            "--site",
            normalized_site,
            "--interaction",
            "auto",
            "--no-browser",
        ])
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("FORCE_NON_TTY", "1")
        .env("EDGEONE_NON_INTERACTIVE", "1")
        .env("EDGEONE_PAGES_API_REGION", normalized_site)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    if let Some(path_val) = prepend_path_env(runtime.node.node_exe.parent()) {
        cmd.env("PATH", path_val);
    }
    apply_no_window_tokio(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 EdgeOne 登录进程失败: {e}"))?;

    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    login_guard.replace(cancel_tx);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let emit_out = Arc::clone(&emit);
    let opened_first = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let opened_out = Arc::clone(&opened_first);
    let last_url = Arc::new(std::sync::Mutex::new(None::<String>));
    let last_url_out = Arc::clone(&last_url);

    let stdout_task = tokio::spawn(async move {
        let mut collected = String::new();
        if let Some(out) = stdout {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let clean = strip_ansi(&line);
                collected.push_str(&clean);
                collected.push('\n');
                if let Some(url) = extract_login_url(&clean) {
                    let is_new = last_url_out
                        .lock()
                        .ok()
                        .map(|mut prev| {
                            if prev.as_deref() == Some(url.as_str()) {
                                false
                            } else {
                                *prev = Some(url.clone());
                                true
                            }
                        })
                        .unwrap_or(false);
                    if is_new {
                        let first = !opened_out.swap(true, std::sync::atomic::Ordering::SeqCst);
                        let msg = if first {
                            if crate::auth::open_external_url(&url).is_err() {
                                "未能自动拉起浏览器，请点击下方链接手动前往腾讯云登录确认"
                                    .to_string()
                            } else {
                                "已在浏览器打开腾讯云授权页，请在浏览器中完成确认...".to_string()
                            }
                        } else {
                            // Note: edgeone CLI opens the secondary workspace confirmation URL itself
                            // regardless of `--no-browser`, so avoid opening a duplicate tab and only
                            // surface the URL as a manual fallback button in the UI.
                            "需要再次在浏览器确认工作空间授权，如未自动弹出请点击下方按钮继续..."
                                .to_string()
                        };
                        emit_out(EdgeOneProgressEvent {
                            stage: "waiting_browser".to_string(),
                            percent: 95,
                            message: msg,
                            login_url: Some(url),
                        });
                    }
                }
            }
        }
        collected
    });

    let stderr_task = tokio::spawn(async move {
        let mut collected = String::new();
        if let Some(err) = stderr {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                collected.push_str(&strip_ansi(&line));
                collected.push('\n');
            }
        }
        collected
    });

    let wait_result = tokio::select! {
        _ = &mut cancel_rx => {
            let _ = child.kill().await;
            login_guard.clear();
            return Err("已取消腾讯云 EdgeOne 登录".to_string());
        }
        res = tokio::time::timeout(Duration::from_secs(CLI_LOGIN_TIMEOUT_SECS), child.wait()) => {
            match res {
                Ok(Ok(status)) => Ok(status),
                Ok(Err(e)) => Err(format!("等待 EdgeOne 登录结果失败: {e}")),
                Err(_) => {
                    let _ = child.kill().await;
                    Err("腾讯云 EdgeOne 浏览器授权超时（超过 5 分钟），请重新点击登录".to_string())
                }
            }
        }
    };

    login_guard.clear();
    let exit_status = wait_result?;
    let stdout_text = stdout_task.await.unwrap_or_default();
    let stderr_text = stderr_task.await.unwrap_or_default();

    if !exit_status.success() {
        let combined = format!("{stdout_text}\n{stderr_text}");
        return Err(friendly_edgeone_error(&combined));
    }

    // Auto-enable `mcp.web_page` once login succeeds so user literally only clicks login!
    let mut state = read_switch_state(paths);
    if !state.mcp.web_page {
        state.mcp.web_page = true;
        let _ = save_switch_state(paths, &state);
    }

    emit(EdgeOneProgressEvent {
        stage: "done".to_string(),
        percent: 100,
        message: "腾讯云 EdgeOne 登录成功，网站上线能力已就绪！".to_string(),
        login_url: None,
    });

    let status = get_status(paths, true).await;
    if !status.authenticated {
        return Err(status
            .error
            .unwrap_or_else(|| "浏览器已返回但未能验证登录状态，请点击「刷新」重试".to_string()));
    }
    Ok(status)
}

pub async fn switch_workspace(paths: &AppPaths, workspace: &str) -> Result<EdgeOneStatus, String> {
    let target = workspace.trim();
    if target.is_empty() {
        return Err("请指定要切换的 Workspace ID 或名称".to_string());
    }
    let runtime = ensure_edgeone_cli(paths, false, &|_| {}).await?;
    let args = vec![
        "workspace".to_string(),
        "use".to_string(),
        target.to_string(),
    ];
    let out = run_edgeone_cli(
        paths,
        &runtime,
        &args,
        None,
        CLI_QUICK_TIMEOUT_SECS,
        2,
        &HashMap::new(),
    )
    .await?;
    if !out.success {
        return Err(friendly_edgeone_error(&out.combined()));
    }
    Ok(get_status(paths, true).await)
}

pub async fn logout(paths: &AppPaths) -> Result<EdgeOneStatus, String> {
    if let Some(runtime) = resolve_edgeone_runtime(paths) {
        let args = vec!["logout".to_string()];
        let _ = run_edgeone_cli(
            paths,
            &runtime,
            &args,
            None,
            CLI_QUICK_TIMEOUT_SECS,
            1,
            &HashMap::new(),
        )
        .await;
    }
    Ok(get_status(paths, false).await)
}

fn is_auth_failure_text(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "not authenticated",
        "not logged in",
        "no api token",
        "please run `edgeone login`",
        "token is not valid",
        "token validation rejected",
        "unauthorized",
        "authentication was rejected",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn friendly_edgeone_error(raw: &str) -> String {
    let clean = strip_ansi(raw);
    let lower = clean.to_ascii_lowercase();
    if is_auth_failure_text(&clean) {
        return "尚未登录腾讯云 EdgeOne 或登录态已失效。请打开 Tako Switch →「MCP 能力」→「网站上线」，点击「一键登录腾讯云 EdgeOne」完成浏览器授权后重试。".to_string();
    }
    if lower.contains("no usable workspace") || lower.contains("cannot be used") || lower.contains("zoneunusableerror") {
        return "当前腾讯云账号下暂无可用的 EdgeOne Makers 工作空间（或空间处于停用/欠费状态），请先在腾讯云 EdgeOne 控制台确认或创建一个免费工作空间后再试。".to_string();
    }
    if is_transient_network_error(&clean) {
        return "连接腾讯云 EdgeOne 接口时网络波动（连接重置或超时），请稍后重试；如开启了全局代理可尝试关闭或切换直连。".to_string();
    }
    let last_meaningful = clean
        .lines()
        .map(str::trim)
        .rev()
        .find(|line| !line.is_empty() && !line.starts_with("at "))
        .unwrap_or("未知错误");
    let snippet: String = last_meaningful.chars().take(360).collect();
    format!("腾讯云 EdgeOne 操作失败：{snippet}")
}

pub fn sanitize_project_name(raw: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            slug.push(lower);
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    let mut out = if trimmed.is_empty() {
        String::new()
    } else if !trimmed.chars().next().unwrap().is_ascii_alphabetic() {
        format!("site-{trimmed}")
    } else {
        trimmed
    };
    if out.len() > 42 {
        out.truncate(42);
        out = out.trim_end_matches('-').to_string();
    }
    out
}

fn short_suffix() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{:x}", secs & 0xfffff)
}

fn read_linked_project_name(dir: &Path) -> Option<String> {
    let p = dir.join(".edgeone").join("project.json");
    let raw = fs::read_to_string(&p).ok()?;
    let val: Value = serde_json::from_str(&raw).ok()?;
    val.get("Name")
        .or_else(|| val.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn resolve_project_name(
    target_path: &Path,
    explicit: Option<&str>,
    configured_default: Option<&str>,
) -> String {
    if let Some(name) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        let s = sanitize_project_name(name);
        if s.len() >= 3 {
            return s;
        }
    }
    if target_path.is_dir() {
        if let Some(linked) = read_linked_project_name(target_path) {
            return linked;
        }
    }
    if let Some(cfg_name) = configured_default.map(str::trim).filter(|s| !s.is_empty()) {
        let s = sanitize_project_name(cfg_name);
        if s.len() >= 3 {
            return s;
        }
    }
    let stem = target_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let base = sanitize_project_name(stem);
    let generic = matches!(
        base.as_str(),
        "" | "dist" | "build" | "out" | "public" | "output" | "www" | "site" | "web" | "index"
    );
    if !generic && base.len() >= 3 {
        base
    } else if !base.is_empty() {
        format!("tako-{base}-{}", short_suffix())
    } else {
        format!("tako-site-{}", short_suffix())
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建临时发布目录失败: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("读取待发布目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("遍历目录项失败: {e}"))?;
        let name = entry.file_name();
        if name == ".git" || name == "node_modules" || name == ".DS_Store" {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(&name);
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败: {e}"))?;
        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if file_type.is_file() {
            fs::copy(&src_path, &dst_path).map_err(|e| format!("复制文件失败: {e}"))?;
        }
    }
    Ok(())
}

/// Prepare the actual path handed to `edgeone makers deploy`:
/// - Single `.html`/`.htm` file -> staged into a temp dir as `index.html`
/// - Directory with NO `index.html`, NO `package.json`/`edgeone.json`, and exactly ONE top-level `.html` file -> staged temp copy with an extra `index.html` so `/` never 404s
/// - Otherwise (normal static folder with `index.html`, framework project, or `.zip`) -> deployed directly in-place.
pub fn prepare_deploy_target(
    raw_path: &Path,
) -> Result<(PathBuf, Option<tempfile::TempDir>), String> {
    if !raw_path.exists() {
        return Err(format!("找不到待部署的路径: {}", raw_path.display()));
    }

    if raw_path.is_file() {
        let ext = raw_path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if ext == "zip" {
            return Ok((raw_path.to_path_buf(), None));
        }
        if ext == "html" || ext == "htm" {
            let tmp = tempfile::TempDir::new()
                .map_err(|e| format!("创建临时打包目录失败: {e}"))?;
            fs::copy(raw_path, tmp.path().join("index.html"))
                .map_err(|e| format!("准备 index.html 失败: {e}"))?;
            let path = tmp.path().to_path_buf();
            return Ok((path, Some(tmp)));
        }
        return Err(format!(
            "不支持直接部署单个 .{ext} 文件，请传入网站文件夹路径、单个 .html 文件或 .zip 压缩包"
        ));
    }

    if raw_path.is_dir() {
        let has_index = raw_path.join("index.html").is_file()
            || raw_path.join("index.htm").is_file();
        let has_project_cfg = raw_path.join("package.json").is_file()
            || raw_path.join("edgeone.json").is_file();
        if !has_index && !has_project_cfg {
            let html_files: Vec<PathBuf> = fs::read_dir(raw_path)
                .map_err(|e| format!("读取目录失败: {e}"))?
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.is_file()
                        && matches!(
                            p.extension()
                                .and_then(|s| s.to_str())
                                .map(|s| s.to_ascii_lowercase())
                                .as_deref(),
                            Some("html" | "htm")
                        )
                })
                .collect();
            if html_files.len() == 1 {
                let tmp = tempfile::TempDir::new()
                    .map_err(|e| format!("创建临时发布目录失败: {e}"))?;
                copy_dir_recursive(raw_path, tmp.path())?;
                fs::copy(&html_files[0], tmp.path().join("index.html"))
                    .map_err(|e| format!("生成入口 index.html 失败: {e}"))?;
                let path = tmp.path().to_path_buf();
                return Ok((path, Some(tmp)));
            }
        }
        return Ok((raw_path.to_path_buf(), None));
    }

    Err(format!("无效的部署目标: {}", raw_path.display()))
}

fn expand_user_path(paths: &AppPaths, raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        paths.home.join(rest)
    } else if let Some(rest) = trimmed.strip_prefix("~\\") {
        paths.home.join(rest)
    } else {
        PathBuf::from(trimmed)
    }
}

pub async fn deploy_website(
    paths: &AppPaths,
    req: EdgeOneDeployRequest,
) -> Result<EdgeOneDeployResult, String> {
    let raw_trimmed = req.path.trim();
    if raw_trimmed.is_empty() {
        return Err("缺少必需参数 path（请提供网站文件夹路径、单个 .html 文件路径或 .zip 压缩包路径）".to_string());
    }

    let source_path = expand_user_path(paths, raw_trimmed);
    let (deploy_target, _temp_guard) = prepare_deploy_target(&source_path)?;

    let state = read_switch_state(paths);
    let has_token = state.mcp.normalized_edgeone_api_token().is_some();
    if !has_token && !has_local_edgeone_credentials(paths) {
        return Err("尚未登录腾讯云 EdgeOne。请打开 Tako Switch → 左侧「MCP 能力」→「网站上线」，点击「一键登录腾讯云 EdgeOne」完成浏览器授权后重试。".to_string());
    }

    let runtime = ensure_edgeone_cli(paths, false, &|_| {}).await?;

    let project_name = resolve_project_name(
        &source_path,
        req.project_name.as_deref(),
        state.mcp.normalized_edgeone_project_name(),
    );
    let environment = match req
        .environment
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("preview") => "preview",
        _ => "production",
    };
    let area = match req
        .area
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("overseas") => "overseas",
        _ => "global",
    };

    let args = vec![
        "makers".to_string(),
        "deploy".to_string(),
        deploy_target.to_string_lossy().to_string(),
        "-n".to_string(),
        project_name.clone(),
        "-e".to_string(),
        environment.to_string(),
        "-a".to_string(),
        area.to_string(),
        "--json".to_string(),
        "--skip-ai-gateway-sync".to_string(),
    ];

    let work_dir = if deploy_target.is_dir() {
        Some(deploy_target.as_path())
    } else {
        deploy_target.parent()
    };

    let mut out = run_edgeone_cli(
        paths,
        &runtime,
        &args,
        work_dir,
        CLI_DEPLOY_TIMEOUT_SECS,
        0,
        &HashMap::new(),
    )
    .await?;

    // Retry once ONLY when a read-only pre-flight lookup failed with a transient connection reset
    // before any upload or deployment was created.
    if !out.success {
        let combined = out.combined();
        if is_transient_network_error(&combined)
            && (combined.contains("DescribeUserInfo")
                || combined.contains("DescribeZones")
                || combined.contains("DescribePagesProjects"))
        {
            tokio::time::sleep(Duration::from_millis(700)).await;
            out = run_edgeone_cli(
                paths,
                &runtime,
                &args,
                work_dir,
                CLI_DEPLOY_TIMEOUT_SECS,
                0,
                &HashMap::new(),
            )
            .await?;
        }
    }

    if let Some(json) = extract_last_json_object(&out.stdout) {
        let status_str = json
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if status_str == "success" {
            let url = json
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "部署已完成但未返回公网访问地址".to_string())?
                .to_string();
            return Ok(EdgeOneDeployResult {
                url,
                project_name,
                project_id: json
                    .get("projectId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                deployment_id: json
                    .get("deploymentId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                console_url: json
                    .get("consoleUrl")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                environment: environment.to_string(),
                area: area.to_string(),
            });
        }
        if let Some(err_msg) = json
            .get("error")
            .or_else(|| json.get("message"))
            .and_then(Value::as_str)
        {
            return Err(friendly_edgeone_error(err_msg));
        }
    }

    if !out.success {
        return Err(friendly_edgeone_error(&out.combined()));
    }

    Err(format!(
        "部署命令退出码 {:?}，但未解析到公网 URL：{}",
        out.exit_code,
        out.combined().chars().take(300).collect::<String>()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn strip_ansi_and_extract_last_json_handles_cli_banners() {
        let raw = "\x1b[90m[cli]\x1b[0m Deploying ./site...\n\x1b[32m✓\x1b[0m Deploy URL: https://demo.edgeone.app\n{\"status\":\"success\",\"url\":\"https://demo.edgeone.app\",\"projectId\":\"pages-123\"}\n";
        let clean = strip_ansi(raw);
        assert!(!clean.contains('\x1b'));
        let parsed = extract_last_json_object(raw).unwrap();
        assert_eq!(parsed["status"], "success");
        assert_eq!(parsed["url"], "https://demo.edgeone.app");
        assert_eq!(parsed["projectId"], "pages-123");
    }

    #[test]
    fn extract_login_url_handles_plain_and_json_lines() {
        assert_eq!(
            extract_login_url("  https://cloud.tencent.com/login?s_url=abc  "),
            Some("https://cloud.tencent.com/login?s_url=abc".to_string())
        );
        assert_eq!(
            extract_login_url(r#"{"status":"waiting","loginUrl":"https://edgeone.cloud.tencent.com/auth?port=1234"}"#),
            Some("https://edgeone.cloud.tencent.com/auth?port=1234".to_string())
        );
        assert_eq!(extract_login_url("Jumping to login page..."), None);
    }

    #[test]
    fn sanitize_and_resolve_project_name_produces_valid_slugs() {
        assert_eq!(sanitize_project_name("My Portfolio_2026!"), "my-portfolio-2026");
        assert_eq!(sanitize_project_name("123-demo"), "site-123-demo");
        assert_eq!(sanitize_project_name("中文项目"), "");

        let tmp = TempDir::new().unwrap();
        let named_dir = tmp.path().join("Cool App");
        fs::create_dir_all(&named_dir).unwrap();
        assert_eq!(resolve_project_name(&named_dir, None, None), "cool-app");
        assert_eq!(
            resolve_project_name(&named_dir, Some("Explicit_Name"), Some("fallback")),
            "explicit-name"
        );
        assert_eq!(
            resolve_project_name(&named_dir, None, Some("Pinned-Site")),
            "pinned-site"
        );

        let dist_dir = tmp.path().join("dist");
        fs::create_dir_all(&dist_dir).unwrap();
        let auto = resolve_project_name(&dist_dir, None, None);
        assert!(auto.starts_with("tako-dist-"));

        // Linked .edgeone/project.json takes precedence over configured default
        fs::create_dir_all(dist_dir.join(".edgeone")).unwrap();
        fs::write(
            dist_dir.join(".edgeone").join("project.json"),
            r#"{"Name":"linked-prod-site"}"#,
        )
        .unwrap();
        assert_eq!(
            resolve_project_name(&dist_dir, None, Some("fallback")),
            "linked-prod-site"
        );
    }

    #[test]
    fn prepare_deploy_target_handles_single_html_file_and_non_index_dir() {
        let tmp = TempDir::new().unwrap();

        // 1. Single HTML file -> staged into temp dir as index.html
        let single = tmp.path().join("landing.html");
        fs::write(&single, "<h1>Hello</h1>").unwrap();
        let (staged_path, guard) = prepare_deploy_target(&single).unwrap();
        assert!(guard.is_some());
        assert_eq!(
            fs::read_to_string(staged_path.join("index.html")).unwrap(),
            "<h1>Hello</h1>"
        );
        drop(guard);

        // 2. Folder with only one non-index HTML file -> staged copy with index.html
        let folder = tmp.path().join("my-page");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("app.html"), "<h1>App</h1>").unwrap();
        fs::write(folder.join("style.css"), "body{}").unwrap();
        let (staged_dir, guard2) = prepare_deploy_target(&folder).unwrap();
        assert!(guard2.is_some());
        assert_eq!(
            fs::read_to_string(staged_dir.join("index.html")).unwrap(),
            "<h1>App</h1>"
        );
        assert_eq!(
            fs::read_to_string(staged_dir.join("style.css")).unwrap(),
            "body{}"
        );
        drop(guard2);

        // 3. Normal folder with index.html -> deployed directly without copying
        let normal = tmp.path().join("normal-site");
        fs::create_dir_all(&normal).unwrap();
        fs::write(normal.join("index.html"), "<h1>Home</h1>").unwrap();
        let (direct_path, guard3) = prepare_deploy_target(&normal).unwrap();
        assert!(guard3.is_none());
        assert_eq!(direct_path, normal);
    }

    #[test]
    fn node_archive_filename_covers_all_supported_targets() {
        assert_eq!(
            node_archive_filename_for("macos", "aarch64", "v22.14.0").unwrap(),
            "node-v22.14.0-darwin-arm64.tar.gz"
        );
        assert_eq!(
            node_archive_filename_for("macos", "x86_64", "v22.14.0").unwrap(),
            "node-v22.14.0-darwin-x64.tar.gz"
        );
        assert_eq!(
            node_archive_filename_for("windows", "x86_64", "v22.14.0").unwrap(),
            "node-v22.14.0-win-x64.zip"
        );
        assert_eq!(
            node_archive_filename_for("windows", "aarch64", "v22.14.0").unwrap(),
            "node-v22.14.0-win-arm64.zip"
        );
    }

    #[test]
    fn transient_network_error_and_friendly_errors_classify_accurately() {
        assert!(is_transient_network_error("Request Failed: DescribeUserInfo: read ECONNRESET"));
        assert!(is_transient_network_error("Error: socket hang up"));
        assert!(!is_transient_network_error("Invalid project name"));

        assert!(friendly_edgeone_error("You are not authenticated. Please run `edgeone login`.")
            .contains("一键登录腾讯云 EdgeOne"));
        assert!(friendly_edgeone_error("read ECONNRESET").contains("网络波动"));
    }

    #[tokio::test]
    async fn mock_edgeone_cli_retries_econnreset_and_parses_status_and_deploy() {
        // Requires a real local Node >= 18 binary to execute the tiny mock JS CLI; skip gracefully if absent.
        let tmp = TempDir::new().unwrap();
        let paths = AppPaths::for_test(tmp.path());
        let Some(node) = resolve_node_runtime(&paths) else {
            return;
        };

        let cli_entry = managed_cli_entry(&paths);
        fs::create_dir_all(cli_entry.parent().unwrap()).unwrap();
        fs::write(
            managed_cli_package_json(&paths),
            r#"{"name":"edgeone","version":"1.7.7"}"#,
        )
        .unwrap();

        let counter_file = tmp.path().join("whoami_attempts.txt");
        let mock_js = format!(
            r#"
const fs = require('fs');
const args = process.argv.slice(2);
const counterFile = {counter:?};
if (args[0] === 'whoami') {{
  let n = 0;
  try {{ n = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; }} catch {{}}
  fs.writeFileSync(counterFile, String(n + 1));
  if (n === 0) {{
    console.error('Request Failed: DescribeUserInfo: read ECONNRESET');
    process.exit(1);
  }}
  console.log(JSON.stringify({{
    status: 'success',
    authenticated: true,
    accountName: '1196768261',
    accountId: '1196768261',
    workspaceId: 'zone-abc',
    workspaceName: 'makers-workspace',
    plan: 'Free',
    workspaceStatus: 'Active'
  }}));
  process.exit(0);
}}
if (args[0] === 'workspace' && args[1] === 'ls') {{
  console.log(JSON.stringify({{
    workspaces: [
      {{ id: 'zone-abc', name: 'makers-workspace', plan: 'Free', available: true, status: 'Active', current: true, cached: true }},
      {{ id: 'zone-pro', name: 'team-pro', plan: 'Pro', available: true, status: 'Active', current: false, cached: true }}
    ]
  }}));
  process.exit(0);
}}
if (args[0] === 'makers' && args[1] === 'deploy') {{
  const nameIdx = args.indexOf('-n');
  const name = nameIdx >= 0 ? args[nameIdx + 1] : 'unknown';
  console.log('\x1b[90m[cli]\x1b[0m Uploading...');
  console.log(JSON.stringify({{
    status: 'success',
    url: `https://${{name}}.edgeone.app`,
    projectId: 'pages-test1',
    deploymentId: 'dep-999',
    consoleUrl: 'https://console.cloud.tencent.com/edgeone/pages/project/pages-test1'
  }}));
  process.exit(0);
}}
console.error('Unexpected args:', args.join(' '));
process.exit(1);
"#,
            counter = counter_file.to_string_lossy().to_string()
        );
        fs::write(&cli_entry, mock_js).unwrap();

        // Simulate existing local credentials
        let eo_dir = paths.home.join(".edgeone");
        fs::create_dir_all(&eo_dir).unwrap();
        fs::write(eo_dir.join("cred"), "mock-token").unwrap();

        let status = get_status(&paths, true).await;
        assert!(status.ready, "expected ready, got: {status:?}");
        assert!(status.authenticated, "expected authenticated after retry, got: {status:?}");
        assert_eq!(status.account_name.as_deref(), Some("1196768261"));
        assert_eq!(status.workspace_id.as_deref(), Some("zone-abc"));
        assert_eq!(status.workspaces.len(), 2);
        assert_eq!(
            fs::read_to_string(&counter_file).unwrap().trim(),
            "2",
            "expected automatic retry after first ECONNRESET"
        );

        let site_file = tmp.path().join("demo.html");
        fs::write(&site_file, "<h1>Live</h1>").unwrap();
        let deployed = deploy_website(
            &paths,
            EdgeOneDeployRequest {
                path: site_file.to_string_lossy().to_string(),
                project_name: Some("My Demo Site".to_string()),
                environment: None,
                area: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(deployed.project_name, "my-demo-site");
        assert_eq!(deployed.url, "https://my-demo-site.edgeone.app");
        assert_eq!(deployed.project_id.as_deref(), Some("pages-test1"));
        assert_eq!(deployed.deployment_id.as_deref(), Some("dep-999"));
        let _ = node;
    }
}
