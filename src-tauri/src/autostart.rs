use crate::config::AppPaths;
#[cfg(unix)]
use crate::config::write_atomic;
#[cfg(unix)]
use std::fs;
use std::path::{Path, PathBuf};

pub const AUTOSTART_ARG: &str = "--autostart";
pub const WINDOWS_RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const WINDOWS_RUN_VALUE_NAME: &str = "TakoSwitch";
pub const MACOS_AUTOSTART_PLIST_LABEL: &str = "tech.shiroha.tako-switch.autostart";
pub const MACOS_AUTOSTART_PLIST_NAME: &str = "tech.shiroha.tako-switch.autostart.plist";
pub const LINUX_AUTOSTART_DESKTOP_NAME: &str = "tako-switch.desktop";

pub fn is_autostart_launch() -> bool {
    std::env::args().any(|arg| arg == AUTOSTART_ARG)
}

fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn format_windows_run_command(exe_path: &Path) -> String {
    format!("\"{}\" {}", exe_path.to_string_lossy(), AUTOSTART_ARG)
}

pub fn render_macos_autostart_plist(exe_path: &Path) -> String {
    let escaped_exe = xml_escape(&exe_path.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{MACOS_AUTOSTART_PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{escaped_exe}</string>
    <string>{AUTOSTART_ARG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
"#
    )
}

pub fn render_linux_desktop_entry(exe_path: &Path) -> String {
    let raw = exe_path.to_string_lossy();
    let escaped = raw.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "[Desktop Entry]\nType=Application\nName=Tako Switch\nExec=\"{escaped}\" {AUTOSTART_ARG}\nX-GNOME-Autostart-enabled=true\n"
    )
}

pub fn macos_autostart_plist_path(paths: &AppPaths) -> PathBuf {
    paths.launch_agents_dir.join(MACOS_AUTOSTART_PLIST_NAME)
}

pub fn linux_autostart_desktop_path(paths: &AppPaths) -> PathBuf {
    if !paths.is_test {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
            return PathBuf::from(xdg)
                .join("autostart")
                .join(LINUX_AUTOSTART_DESKTOP_NAME);
        }
    }
    paths
        .home
        .join(".config")
        .join("autostart")
        .join(LINUX_AUTOSTART_DESKTOP_NAME)
}

pub fn sync_auto_launch(paths: &AppPaths, enable: bool) -> Result<(), String> {
    let exe = paths.mcp_server_exe();
    sync_auto_launch_with_exe(paths, &exe, enable)
}

pub fn sync_auto_launch_with_exe(
    paths: &AppPaths,
    exe_path: &Path,
    enable: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if paths.is_test {
            return Ok(());
        }
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if enable {
            let (run_key, _) = hkcu
                .create_subkey(WINDOWS_RUN_SUBKEY)
                .map_err(|e| format!("打开开机启动注册表项失败: {e}"))?;
            let cmd = format_windows_run_command(exe_path);
            run_key
                .set_value(WINDOWS_RUN_VALUE_NAME, &cmd)
                .map_err(|e| format!("写入开机启动注册表失败: {e}"))?;
        } else if let Ok(run_key) = hkcu.open_subkey_with_flags(WINDOWS_RUN_SUBKEY, KEY_SET_VALUE) {
            match run_key.delete_value(WINDOWS_RUN_VALUE_NAME) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("移除开机启动注册表失败: {e}")),
            }
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        let plist_path = macos_autostart_plist_path(paths);
        if enable {
            let plist = render_macos_autostart_plist(exe_path);
            if fs::read_to_string(&plist_path).ok().as_deref() != Some(plist.as_str()) {
                write_atomic(&plist_path, plist.as_bytes(), false)?;
            }
        } else if plist_path.exists() {
            fs::remove_file(&plist_path)
                .map_err(|e| format!("移除开机启动配置 {} 失败: {e}", plist_path.display()))?;
        }
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let desktop_path = linux_autostart_desktop_path(paths);
        if enable {
            let content = render_linux_desktop_entry(exe_path);
            if fs::read_to_string(&desktop_path).ok().as_deref() != Some(content.as_str()) {
                write_atomic(&desktop_path, content.as_bytes(), false)?;
            }
        } else if desktop_path.exists() {
            fs::remove_file(&desktop_path)
                .map_err(|e| format!("移除开机启动配置 {} 失败: {e}", desktop_path.display()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn windows_run_command_quotes_exe_and_appends_autostart_arg() {
        let exe = Path::new(r"C:\Program Files\Tako Switch\tako-switch.exe");
        assert_eq!(
            format_windows_run_command(exe),
            r#""C:\Program Files\Tako Switch\tako-switch.exe" --autostart"#
        );
    }

    #[test]
    fn macos_plist_escapes_xml_and_sets_non_keepalive_run_at_load() {
        let exe = Path::new("/Applications/Tako & Switch.app/Contents/MacOS/tako-switch");
        let plist = render_macos_autostart_plist(exe);
        assert!(plist.contains("<string>tech.shiroha.tako-switch.autostart</string>"));
        assert!(plist.contains(
            "<string>/Applications/Tako &amp; Switch.app/Contents/MacOS/tako-switch</string>"
        ));
        assert!(plist.contains("<string>--autostart</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(plist.contains("<key>KeepAlive</key>\n  <false/>"));
    }

    #[test]
    fn linux_desktop_entry_contains_exec_and_autostart_flag() {
        let exe = Path::new("/usr/local/bin/tako-switch");
        let entry = render_linux_desktop_entry(exe);
        assert!(entry.contains("Type=Application"));
        assert!(entry.contains("Exec=\"/usr/local/bin/tako-switch\" --autostart"));
        assert!(entry.contains("X-GNOME-Autostart-enabled=true"));
    }

    #[test]
    fn sync_auto_launch_in_test_paths_succeeds_for_enable_and_disable() {
        let tmp = TempDir::new().unwrap();
        let paths = AppPaths::for_test(tmp.path());
        let exe = Path::new("/Applications/Tako Switch.app/Contents/MacOS/tako-switch");

        sync_auto_launch_with_exe(&paths, exe, true).unwrap();
        #[cfg(target_os = "macos")]
        assert!(macos_autostart_plist_path(&paths).exists());
        #[cfg(all(unix, not(target_os = "macos")))]
        assert!(linux_autostart_desktop_path(&paths).exists());

        sync_auto_launch_with_exe(&paths, exe, false).unwrap();
        #[cfg(target_os = "macos")]
        assert!(!macos_autostart_plist_path(&paths).exists());
        #[cfg(all(unix, not(target_os = "macos")))]
        assert!(!linux_autostart_desktop_path(&paths).exists());
    }
}
