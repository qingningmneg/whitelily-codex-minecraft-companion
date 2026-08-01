# Unsigned installer and Windows SmartScreen

[中文](smartscreen.zh-CN.md)

> `WhiteLily-0.2.0-beta.1-windows-x64-setup.exe` is being built and verified and is not yet published. This page explains how to handle the unsigned warning only after the first Beta passes acceptance and is released.

## Why Windows warns

The first WhiteLily desktop Beta is planned as an **unsigned** EXE without an Authenticode code-signing certificate. Windows SmartScreen may therefore show “Windows protected your PC” or “Unknown publisher.” Unsigned status is a disclosed release limitation and must not be described as signed or reputation-established.

A SmartScreen warning proves neither that a file is malicious nor that it is safe. Trust the file only when it came from the official Release and its locally calculated SHA-256 exactly matches the `.sha256` published in that same Release.

## Safe workflow

1. Confirm that the download page is the official repository's [GitHub Releases](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases) page.
2. Download both `WhiteLily-0.2.0-beta.1-windows-x64-setup.exe` and its `.sha256`.
3. Follow the [Windows installation guide](installation-windows.md#3-verify-sha-256-before-installation) to verify SHA-256 in PowerShell.
4. Open the EXE only when both its source and hash are correct.
5. When SmartScreen appears, recheck the filename, select **More info**, then **Run anyway**.

Do not:

- Disable SmartScreen, Windows Defender, or other system-wide protection.
- Ignore a SHA-256 mismatch.
- Run a same-named EXE from a chat attachment, file-sharing service, third-party mirror, or source folder.
- Reuse an old version's verification result for a new installer.

If any step cannot be confirmed, stop, delete the file, and wait for the official Release or download it again.

## Current limitations

- The installer is unsigned and may show an unknown publisher.
- The first Beta does not support cross-device deployment and connects only to same-machine `127.0.0.1`.
- Minecraft Java Edition 1.21.5 is the first Beta acceptance target; other versions are unsupported.
- PCL2 remains under your control: you start and operate PCL2; WhiteLily does not launch, control, click, or modify PCL2.
- Sign in with ChatGPT after installation; there is no Platform API-key fallback.
- The installer requires no system Node.js, npm, Git, or Codex CLI.

If code signing is added later, the release notes will explicitly state the signing status and verification method. Until then, every Release must include the `.sha256` and unsigned-status notice.
