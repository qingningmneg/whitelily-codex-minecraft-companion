# Changelog

## 未发布 / Unreleased

## `0.2.0-beta.1` — 2026-08-02

中文：

- 发布面向 Windows 10/11 x64 的 Electron 桌面应用和按用户安装的 NSIS EXE；通过 Windows Sandbox 七阶段安装生命周期与 Minecraft Java 1.21.5 同机 LAN 连接验收。
- 安装包内置 Electron、WhiteLily 后台运行时和固定版本 Codex CLI，不依赖系统 Node.js、npm、Git 或 Codex CLI。
- 新增 ChatGPT 登录、实时模型选择、只读 PCL2 发现、同机 `127.0.0.1` Minecraft Java 1.21.5 LAN 确认，以及桌面控制面板。
- 发布匹配的 SHA-256 和未签名状态说明；首个 Beta 可能触发 Windows SmartScreen“未知发布者”提示。
- 修复 ChatGPT 已登录但引导页继续等待，以及重复确认同一主人时核心被误判为不可用的问题。
- 升级保留 `%LOCALAPPDATA%\WhiteLily`。卸载提供“保留 WhiteLily 数据（默认）”和“删除 WhiteLily 数据”，静默卸载保留数据。

English:

- Releases an Electron desktop app and per-user NSIS EXE for Windows 10/11 x64, accepted through a seven-stage Windows Sandbox lifecycle and a same-machine Minecraft Java 1.21.5 LAN connection check.
- The installer bundles Electron, the WhiteLily child runtime, and an exact Codex CLI without relying on system Node.js, npm, Git, or Codex CLI.
- Adds ChatGPT sign-in, live model selection, read-only PCL2 discovery, same-machine `127.0.0.1` Minecraft Java Edition 1.21.5 LAN confirmation, and a desktop control panel.
- Publishes a matching SHA-256 and unsigned-status notice. The first Beta may trigger a Windows SmartScreen unknown-publisher warning.
- Fixes onboarding remaining on the waiting page after ChatGPT sign-in and a false core-unavailable error when confirming the same owner again.
- Upgrades preserve `%LOCALAPPDATA%\WhiteLily`. Uninstall offers **Keep WhiteLily data (default)** and **Delete WhiteLily data**; silent uninstall keeps data.

## 0.1.1

- Added the reusable runtime facade, runtime events, and separated Minecraft connection lifecycle.
- Added single-active-task control, immutable task budgets, and complete in-game task disclosure.
- Hardened high-risk confirmations, world/session fail-closed behavior, emergency cancellation, redaction, and local audit boundaries.
- Expanded automated coverage to 32 test files and 831 tests.
- Refreshed the Windows preview package and installation documentation for the latest `main`.

## 0.1.0

- First Windows 11, PCL2, Minecraft Java 1.21.5 release candidate.
- Local ChatGPT-authenticated Codex companion with friend, balanced, and autonomous modes.
- Windows lifecycle scripts, safety controls, release leak checks, and reproducible release packaging.
