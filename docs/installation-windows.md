# WhiteLily Windows installation, upgrade, and uninstall guide

[中文](installation-windows.zh-CN.md)

> **Status: `v0.2.0-beta.2` Public Beta candidate.** It combines model hot switching and the Minecraft action workspace in one unsigned Windows x64 installer. This candidate passed isolated clean installation, in-place beta.1 upgrade, workspace repair, data-preservation, uninstall, and reinstall checks. Real game actions are accepted only in a confirmed disposable Minecraft Java 1.21.5 LAN world. Verify its SHA-256. The latest publicly released desktop build remains `v0.2.0-beta.1`; beta.2 will not be published before its remaining gates pass.

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

1. [`WhiteLily-0.2.0-beta.2-windows-x64-setup.exe`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/download/v0.2.0-beta.2/WhiteLily-0.2.0-beta.2-windows-x64-setup.exe)
2. [`WhiteLily-0.2.0-beta.2-windows-x64-setup.exe.sha256`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/download/v0.2.0-beta.2/WhiteLily-0.2.0-beta.2-windows-x64-setup.exe.sha256)

Do not obtain a same-named EXE from source folders, chat attachments, file-sharing services, or third-party mirrors. A matching filename does not prove matching contents.

## 3. Verify SHA-256 before installation

Place the EXE and `.sha256` file in the same directory, open PowerShell in that directory, and run:

```powershell
$installer = ".\WhiteLily-0.2.0-beta.2-windows-x64-setup.exe"
$checksum = ".\WhiteLily-0.2.0-beta.2-windows-x64-setup.exe.sha256"
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

The beta.2 installer also bundles a byte-verified Minecraft component pack: WhiteLily Bridge, optional WhiteLily Avatar, Fabric API `0.128.2+1.21.5`, GeckoLib `5.1.0`, and their licenses. Assisted setup checks Bridge and Avatar by default; silent setup enables both by default. Setup writes the preference once only when `%LOCALAPPDATA%\WhiteLily\config\minecraft-components.json` is absent. It does not search for PCL2, guess a game directory, or write into Minecraft. Upgrade, reinstall, and **Keep Data** uninstall preserve an existing preference unchanged.

Only the desktop app may install those fixed components into the **currently verified PCL2 instance running Fabric Loader `>=0.16.14` and Minecraft Java `1.21.5`**. Bridge is required for official-auth LAN; Avatar is optional and depends on Bridge, the pinned Fabric API, and GeckoLib. Restart that Minecraft instance after a component write; existing worlds are unchanged. WhiteLily never reads or reuses PCL2, Microsoft, or Minecraft credentials and never changes global online authentication, `online-mode`, the whitelist, scoreboards/teams, or persistent world data.

## 6. First launch

1. Open WhiteLily.
2. Complete ChatGPT sign-in inside the app.
3. Select a model and reasoning effort from the live catalog returned for the current account.
4. Configure the owner with the exact Minecraft Java username, including capitalization.
5. Keep the default safety boundary and begin with a disposable test world.

Authentication files stay under the controlled `%LOCALAPPDATA%\WhiteLily` data root. WhiteLily does not ask you to paste an API key into configuration and has no API Key fallback.

### Persistent model hot switching and action workspace

`v0.2.0-beta.2` includes both capabilities in the same installer; there is no separate model or action installer.

Open **AI model** after first-run setup, choose a model and reasoning effort from the current ChatGPT session's live catalog, then select **Apply model**. A successful switch stops the active task and revokes its pending actions without disconnecting the confirmed Minecraft LAN session. WhiteLily saves and displays the new selection only after the model is ready, and keeps using it after either the child runtime or desktop app restarts.

If switching fails, WhiteLily keeps the previous model selection and connection. Do not work around the failure by repeatedly restarting, editing local authentication files, or pasting an API key. Retry once, then save a redacted diagnostic and report the problem if it continues.

On every start WhiteLily verifies exactly three managed files under `%LOCALAPPDATA%\WhiteLily\codex-workspace`: `.codex/config.toml`, `AGENTS.md`, and `workspace-manifest.json`. A missing, stale, or modified ordinary directory is atomically repaired from the attested installer copy. Stable recovery codes are `WORKSPACE_RESOURCE_INVALID`, `WORKSPACE_DEPLOY_FAILED`, and `WORKSPACE_ROLLBACK_FAILED`. Quit completely and retry first, then run the same beta.2 installer as a repair installation. Do not download scripts manually or write an API key into the workspace.

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

The published `v0.1.1` CLI ZIP is an older developer preview and does require Node.js, npm, a Git/source workspace, and Codex CLI. Those requirements do not apply to the `v0.2.0-beta.2` desktop installer.

For maintainer installer validation, the lifecycle test establishes a real Windows principal boundary inside Windows Sandbox: the trusted controller runs as `SYSTEM`, an interactive bootstrap process acts only as a trusted launch broker, and the installer, application, and uninstaller always run as a disposable standard local candidate user. Report and control state live in a guest-local SYSTEM/Administrators-only directory, and the candidate's malicious write probe must receive AccessDenied. Because a Sandbox mapped folder is not treated as a guest ACL security boundary, the final schema 2 report returns inside an HMAC-SHA256 envelope made with a one-time 256-bit host key. Before writing that envelope, the controller exclusively owns a mapped shutdown guard, checks that the system shutdown command starts successfully, and keeps both the controller and guard alive until guest shutdown terminates them. The host must authenticate the envelope, wait until it can exclusively acquire the guard, and authenticate the envelope again before continuing. A guard timeout or shutdown-start failure is fail-closed: the mapping is retained and the operator must close Windows Sandbox manually.

The controller directly verifies the candidate's per-user installation tree, data tree, registry hive, independently observed installer hashes, and all 15 stages, and signs the report only after removing the candidate user. It also rehashes all nine installed Minecraft component resources, proves that a clean install creates the exact schema 1 preference without BOM or newline, and proves that beta.1 upgrade, **Keep Data**, and reinstall never overwrite the user's preference; **Delete Data** finally removes that file with the fixed data root. The host tracks only the exact `WindowsSandbox.exe` process it started and never enumerates or terminates other Sandbox sessions by process name. Successful cleanup uses a two-level fixed allowlist: it first inspects every top-level entry in the mapping root and report directory and rejects any unexpected directory, reparse point, extra name, or non-ordinary file. It then deletes only approved ordinary files by fixed `LiteralPath` and removes the two proven-empty directories non-recursively. A contaminated mapping is never recursively deleted; retain the exact reported path, close Windows Sandbox, inspect it manually, and delete only verified ordinary files. Both Keep Data and Delete Data uninstall paths must prove after a bounded wait that the program root, `WhiteLily.exe`, uninstaller, and registry entry are absent.

## 13. Known Beta limits

- Only same-machine `127.0.0.1` Minecraft Java 1.21.5 LAN worlds are supported; remote hosts are not supported.
- Model catalog, response latency, and usage limits depend on the current ChatGPT/Codex account; there is no Platform API-key fallback.
- Game actions are limited to the constrained tools WhiteLily currently discovers and verifies; arbitrary natural-language requests are not guaranteed to execute.
- You still start and operate PCL2, Minecraft, and the LAN world and must test every update in a disposable world first.

Maintainers validating a desktop build from source use locked dependencies and repository development scripts. Ordinary installer users do not clone the repository or run `npm ci`. Isolated lifecycle automation does not replace manual Minecraft acceptance; only a build that passes both isolated lifecycle and same-machine Minecraft 1.21.5 connection acceptance may be merged, tagged, or offered as a prerelease installer.
