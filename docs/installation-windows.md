# WhiteLily Windows installation, upgrade, and uninstall guide

[中文](installation-windows.zh-CN.md)

> **Status: the `v0.2.0-beta.1` Public Beta passed isolated Windows installer lifecycle and same-machine Minecraft Java 1.21.5 LAN connection acceptance and is available as a GitHub prerelease.** This is an unsigned test build. Verify its SHA-256 and use only a disposable world.

The published `v0.1.1` is an older CLI ZIP preview for developers and early testers. It requires system development tools and is not the desktop EXE described below.

## 1. Supported boundary

The first desktop Beta targets:

- Windows 10/11 x64, installed per user without administrator rights.
- Plain Craft Launcher 2 (PCL2), downloaded, started, and operated by you.
- **Minecraft Java Edition 1.21.5**; untested versions are outside the first Beta support boundary.
- WhiteLily, PCL2, Minecraft, and the bundled Codex runtime on the same computer.
- Only a Minecraft LAN world that you manually open on `127.0.0.1`; cross-device deployment and remote LAN hosts are not supported.
- ChatGPT sign-in inside WhiteLily, with no Platform API-key fallback.

WhiteLily does not launch, control, click, or modify PCL2. It does not automatically start Minecraft or open a world to LAN. You perform those steps and confirm the detected local session in WhiteLily.

## 2. Download both files

Download these files from the official [GitHub Releases](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases) page:

1. [`WhiteLily-0.2.0-beta.1-windows-x64-setup.exe`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/download/v0.2.0-beta.1/WhiteLily-0.2.0-beta.1-windows-x64-setup.exe)
2. [`WhiteLily-0.2.0-beta.1-windows-x64-setup.exe.sha256`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/download/v0.2.0-beta.1/WhiteLily-0.2.0-beta.1-windows-x64-setup.exe.sha256)

Do not obtain a same-named EXE from source folders, chat attachments, file-sharing services, or third-party mirrors. A matching filename does not prove matching contents.

## 3. Verify SHA-256 before installation

Place the EXE and `.sha256` file in the same directory, open PowerShell in that directory, and run:

```powershell
$installer = ".\WhiteLily-0.2.0-beta.1-windows-x64-setup.exe"
$checksum = ".\WhiteLily-0.2.0-beta.1-windows-x64-setup.exe.sha256"
$expected = ((Get-Content -Raw $checksum).Trim() -split "\s+")[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA-256 mismatch. Do not run the installer." }
"SHA-256 verified: $actual"
```

Continue only when the command prints `SHA-256 verified`. If the hash differs, the checksum has an unexpected format, or the files came from different sources, delete both and download them again from the official Release. Visual similarity is not verification.

## 4. Unsigned build and SmartScreen

The first Beta is **unsigned**, so Windows SmartScreen may show “Windows protected your PC” or “Unknown publisher.” This warning does not replace hash verification and does not make arbitrary same-named files safe.

After confirming both the official source and SHA-256, follow the [unsigned build and Windows SmartScreen guide](smartscreen.md), review the file again, and select **More info → Run anyway**. Do not disable SmartScreen, lower system-wide security settings, or bypass the warning for an unknown source or mismatched hash.

## 5. Install

1. Exit any running WhiteLily development or older desktop build.
2. Double-click the EXE whose SHA-256 you verified.
3. Review the assisted setup and confirm the per-user installation.
4. Open WhiteLily from the Start menu or desktop shortcut.

Default program directory:

```text
%LOCALAPPDATA%\Programs\WhiteLily
```

Default user-data directory:

```text
%LOCALAPPDATA%\WhiteLily
```

The installer is designed to bundle Electron, the compiled WhiteLily child runtime, an exact Codex CLI, production dependencies, and license material. An ordinary user **does not need system Node.js, npm, Git, or Codex CLI**, and setup does not download executable dependencies. PCL2 and Minecraft are not included; obtain them separately from trusted sources.

## 6. First launch

1. Open WhiteLily.
2. Complete ChatGPT sign-in inside the app.
3. Select a model and reasoning effort from the live catalog returned for the current account.
4. Configure the owner with the exact Minecraft Java username, including capitalization.
5. Keep the default safety boundary and begin with a disposable test world.

Authentication files stay under the controlled `%LOCALAPPDATA%\WhiteLily` data root. WhiteLily does not ask you to paste an API key into configuration and has no API Key fallback.

### Switch models later

After first-run setup, open **AI model** at any time, choose a model and reasoning effort from the current ChatGPT session's live catalog, then select **Apply model**. A successful switch stops the active task and revokes its pending actions without disconnecting the confirmed Minecraft LAN session. WhiteLily saves and displays the new selection only after the model is ready, and keeps using it after either the child runtime or desktop app restarts.

If switching fails, WhiteLily keeps the previous model selection and connection. Do not work around the failure by repeatedly restarting, editing local authentication files, or pasting an API key. Retry once, then save a redacted diagnostic and report the problem if it continues.

## 7. Enter Minecraft with PCL2

1. You start and operate PCL2 yourself.
2. Use PCL2 to start Minecraft Java Edition 1.21.5.
3. Enter a disposable single-player world.
4. Press `Esc`, choose **Open to LAN**, and manually open the world.
5. Return to WhiteLily and review the detected version, process, `127.0.0.1` address, and port.
6. Confirm the connection only when those details are correct.

WhiteLily does not scan other computers on the LAN, accept a remote host proposed by the model, or read PCL2 account credentials. The port can change every time you reopen a world to LAN, so review the candidate again.

## 8. Upgrade

Updates are manual. WhiteLily does not download or run a new installer in the background:

1. Stop the current task and companion in WhiteLily.
2. Choose **Quit** from the system tray and confirm the app is no longer running.
3. Download the new EXE and matching `.sha256` from the official Release.
4. Verify SHA-256 again, then run the new installer.
5. Complete the post-upgrade smoke test in a disposable world.

An upgrade with the stable product identity replaces only program files. The upgrade preserves settings, configuration, companion profiles, memory, world bindings, logs, and other user data under `%LOCALAPPDATA%\WhiteLily`. Back up important local configuration before upgrading anyway, and never copy the data root into the program directory.

## 9. Uninstall

Stop the companion and quit WhiteLily from the system tray, then run the uninstaller from Windows Installed apps. Interactive uninstall presents two explicit choices:

- **Keep WhiteLily data (default):** remove program files while preserving `%LOCALAPPDATA%\WhiteLily` for a future reinstall or upgrade.
- **Delete WhiteLily data:** remove program files and delete WhiteLily settings, authentication state, companion profiles, memory, logs, and diagnostics. This cannot be undone.

Silent uninstall also keeps data by default. The uninstaller may delete data only after you explicitly select **Delete WhiteLily data** in the interactive flow and only when the resolved target exactly equals the current user's `%LOCALAPPDATA%\WhiteLily`. It must not delete a parent directory, wildcard path, network path, or another application's data.

## 10. Privacy and local data

- WhiteLily collects no telemetry and does not automatically upload logs or diagnostic bundles.
- PCL2 credentials, Minecraft saves, and the owner username are not uploaded as public diagnostics.
- ChatGPT/Codex authentication, settings, memory, and redacted logs remain in the local WhiteLily data root.
- WhiteLily accesses only the same-machine `127.0.0.1` Minecraft LAN session that you confirm.
- Review logs and screenshots manually before sharing them.

## 11. Troubleshooting

### The system has no `node`, `npm`, `git`, or `codex`

That is the expected environment for the desktop installer. The released package contains its runtime and does not rely on system Node.js, npm, Git, or Codex CLI. If an installed WhiteLily build asks for those commands, do not install tools to work around it; save a redacted diagnostic and report an installer defect.

### PCL2 is not found

WhiteLily performs read-only discovery and does not install or start PCL2 for you. Install PCL2 from its official source, start and operate PCL2 yourself, then refresh discovery in WhiteLily.

### Minecraft does not connect

Confirm Minecraft Java Edition is exactly 1.21.5, the world is still open to LAN, the candidate address is `127.0.0.1`, and no player or bot already uses the WhiteLily name. Do not substitute another computer's LAN address.

### SmartScreen still blocks the installer

Do not disable system protection. Recheck the official download source and SHA-256, then read the [SmartScreen guide](smartscreen.md). If either cannot be verified, do not run the file.

## 12. Developer preview

The published `v0.1.1` CLI ZIP is an older developer preview and does require Node.js, npm, a Git/source workspace, and Codex CLI. Those requirements do not apply to the `v0.2.0-beta.1` desktop installer.

Maintainers validating a desktop build from source use locked dependencies and repository development scripts. Ordinary installer users do not clone the repository or run `npm ci`. Only a build that passes isolated lifecycle and same-machine Minecraft 1.21.5 connection acceptance may be offered as a prerelease installer.
